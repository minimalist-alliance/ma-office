/* SPDX-License-Identifier: Apache-2.0 */
/* yuvconv: BGRx/BGRA -> I420/NV12 with libyuv (NEON), as a cheaper replacement for videoconvert in the Neko
 * capture pipeline. Optional variable-frame-rate mode (drop-duplicates=true): a frame byte-identical to the
 * previous input frame is dropped before conversion/encode unless heartbeat-ms has passed since the last
 * frame that was let through. Output is BT.601 limited range (what libyuv ARGBToI420/ARGBToNV12 produce), and
 * the src caps say so (colorimetry=bt601) so x264 signals it in the VUI.
 * active-ms (VFR only): after the last real change, keep passing every frame (duplicates too) for this long, so a
 * stream with motion stays at the full capture rate and only a page that has been static for active-ms is thinned.
 * keyframe-ms (VFR only): Neko v3.2.0 ignores client PLIs and its first IDR is usually sent before the peer
 * is connected, so viewers rely on periodic keyframes (key-int-max counts frames, which VFR stretches);
 * every keyframe-ms of stream time this element lets a frame through and pushes a force-key-unit event.
 * Build: gcc -O2 -shared -fPIC -o libgstyuvconv.so yuvconv.c $(pkg-config --cflags --libs gstreamer-video-1.0) -lyuv
 */
#include <gst/gst.h>
#include <gst/video/video.h>
#include <gst/video/gstvideofilter.h>
#include <libyuv.h>
#include <string.h>

#define PACKAGE "yuvconv"
#define VERSION "1.0"

typedef struct {
  GstVideoFilter parent;
  gboolean drop_dups;
  guint heartbeat_ms;
  guint log_every;
  guint keyframe_ms;
  guint active_ms;
  GstClockTime last_change_pts;
  GstBuffer *prev;
  GstClockTime last_out_pts;
  GstClockTime last_kf_pts;
  guint64 n_in, n_out, n_drop;
  gint64 conv_ns, cmp_ns;
} GstYuvConv;

typedef struct {
  GstVideoFilterClass parent_class;
} GstYuvConvClass;

GType gst_yuv_conv_get_type (void);
G_DEFINE_TYPE (GstYuvConv, gst_yuv_conv, GST_TYPE_VIDEO_FILTER);

enum { PROP_0, PROP_DROP_DUPS, PROP_HEARTBEAT_MS, PROP_LOG_EVERY, PROP_KEYFRAME_MS, PROP_ACTIVE_MS };

static GstStaticPadTemplate sink_t = GST_STATIC_PAD_TEMPLATE ("sink", GST_PAD_SINK, GST_PAD_ALWAYS,
    GST_STATIC_CAPS (GST_VIDEO_CAPS_MAKE ("{ BGRx, BGRA }")));
static GstStaticPadTemplate src_t = GST_STATIC_PAD_TEMPLATE ("src", GST_PAD_SRC, GST_PAD_ALWAYS,
    GST_STATIC_CAPS (GST_VIDEO_CAPS_MAKE ("{ I420, NV12 }")));

static void
set_formats (GstStructure * s, const char *a, const char *b)
{
  GValue l = G_VALUE_INIT, v = G_VALUE_INIT;
  g_value_init (&l, GST_TYPE_LIST);
  g_value_init (&v, G_TYPE_STRING);
  g_value_set_string (&v, a);
  gst_value_list_append_value (&l, &v);
  g_value_set_string (&v, b);
  gst_value_list_append_value (&l, &v);
  g_value_unset (&v);
  gst_structure_take_value (s, "format", &l);
}

static GstCaps *
yc_transform_caps (GstBaseTransform * bt, GstPadDirection dir, GstCaps * caps, GstCaps * filter)
{
  GstCaps *res = gst_caps_new_empty ();
  guint i, n = gst_caps_get_size (caps);
  for (i = 0; i < n; i++) {
    GstStructure *s = gst_structure_copy (gst_caps_get_structure (caps, i));
    gst_structure_remove_fields (s, "format", "colorimetry", "chroma-site", NULL);
    if (dir == GST_PAD_SINK) {
      set_formats (s, "I420", "NV12");
      gst_structure_set (s, "colorimetry", G_TYPE_STRING, "bt601", NULL);
    } else {
      set_formats (s, "BGRx", "BGRA");
    }
    res = gst_caps_merge_structure (res, s);
  }
  if (filter) {
    GstCaps *t = gst_caps_intersect_full (filter, res, GST_CAPS_INTERSECT_FIRST);
    gst_caps_unref (res);
    res = t;
  }
  return res;
}

static gboolean
same_as_prev (GstYuvConv * self, GstVideoFrame * in)
{
  GstMapInfo m;
  gboolean same = FALSE;
  gsize sz = gst_buffer_get_size (in->buffer);
  if (!self->prev || gst_buffer_get_size (self->prev) != sz)
    return FALSE;
  if (!gst_buffer_map (self->prev, &m, GST_MAP_READ))
    return FALSE;
  same = memcmp (m.data, GST_VIDEO_FRAME_PLANE_DATA (in, 0),
      (gsize) GST_VIDEO_FRAME_PLANE_STRIDE (in, 0) * GST_VIDEO_FRAME_HEIGHT (in)) == 0;
  gst_buffer_unmap (self->prev, &m);
  return same;
}

static GstFlowReturn
yc_transform_frame (GstVideoFilter * f, GstVideoFrame * in, GstVideoFrame * out)
{
  GstYuvConv *self = (GstYuvConv *) f;
  const uint8_t *s = GST_VIDEO_FRAME_PLANE_DATA (in, 0);
  int ss = GST_VIDEO_FRAME_PLANE_STRIDE (in, 0);
  int w = GST_VIDEO_FRAME_WIDTH (in), h = GST_VIDEO_FRAME_HEIGHT (in);
  GstClockTime pts = GST_BUFFER_PTS (in->buffer);
  gint64 t0;

  self->n_in++;
  if (self->log_every && self->n_in % self->log_every == 0) {
    g_printerr ("yuvconv: in=%" G_GUINT64_FORMAT " out=%" G_GUINT64_FORMAT " dropped=%" G_GUINT64_FORMAT
        " avg_convert_us=%.0f avg_compare_us=%.0f\n", self->n_in, self->n_out, self->n_drop,
        self->n_out ? self->conv_ns / 1e3 / self->n_out : 0.0, self->cmp_ns / 1e3 / self->n_in);
  }
  if (self->drop_dups) {
    gboolean same, want_kf = FALSE;
    t0 = g_get_monotonic_time ();
    same = same_as_prev (self, in);
    self->cmp_ns += (g_get_monotonic_time () - t0) * 1000;
    if (self->keyframe_ms && GST_CLOCK_TIME_IS_VALID (pts)) {
      if (!GST_CLOCK_TIME_IS_VALID (self->last_kf_pts))
        self->last_kf_pts = pts;
      else if (pts - self->last_kf_pts >= (GstClockTime) self->keyframe_ms * GST_MSECOND)
        want_kf = TRUE;
    }
    if (want_kf) {
      GstClockTime rt = gst_segment_to_running_time (&GST_BASE_TRANSFORM (self)->segment, GST_FORMAT_TIME, pts);
      gst_pad_push_event (GST_BASE_TRANSFORM_SRC_PAD (self),
          gst_video_event_new_downstream_force_key_unit (pts, GST_CLOCK_TIME_NONE, rt, TRUE, 0));
      self->last_kf_pts = pts;
    } else if (same && GST_CLOCK_TIME_IS_VALID (pts) && GST_CLOCK_TIME_IS_VALID (self->last_out_pts) &&
        pts - self->last_out_pts < (GstClockTime) self->heartbeat_ms * GST_MSECOND &&
        !(GST_CLOCK_TIME_IS_VALID (self->last_change_pts) &&
          pts - self->last_change_pts < (GstClockTime) self->active_ms * GST_MSECOND)) {
      self->n_drop++;
      return GST_BASE_TRANSFORM_FLOW_DROPPED;
    }
    if (!same) {
      gst_buffer_replace (&self->prev, in->buffer);
      self->last_change_pts = pts;
    }
    self->last_out_pts = pts;
  }
  t0 = g_get_monotonic_time ();
  if (GST_VIDEO_FRAME_FORMAT (out) == GST_VIDEO_FORMAT_I420) {
    ARGBToI420 (s, ss,
        GST_VIDEO_FRAME_PLANE_DATA (out, 0), GST_VIDEO_FRAME_PLANE_STRIDE (out, 0),
        GST_VIDEO_FRAME_PLANE_DATA (out, 1), GST_VIDEO_FRAME_PLANE_STRIDE (out, 1),
        GST_VIDEO_FRAME_PLANE_DATA (out, 2), GST_VIDEO_FRAME_PLANE_STRIDE (out, 2), w, h);
  } else {
    ARGBToNV12 (s, ss,
        GST_VIDEO_FRAME_PLANE_DATA (out, 0), GST_VIDEO_FRAME_PLANE_STRIDE (out, 0),
        GST_VIDEO_FRAME_PLANE_DATA (out, 1), GST_VIDEO_FRAME_PLANE_STRIDE (out, 1), w, h);
  }
  self->conv_ns += (g_get_monotonic_time () - t0) * 1000;
  self->n_out++;
  return GST_FLOW_OK;
}

static gboolean
yc_stop (GstBaseTransform * bt)
{
  GstYuvConv *self = (GstYuvConv *) bt;
  gst_buffer_replace (&self->prev, NULL);
  self->last_out_pts = GST_CLOCK_TIME_NONE;
  self->last_kf_pts = GST_CLOCK_TIME_NONE;
  self->last_change_pts = GST_CLOCK_TIME_NONE;
  return TRUE;
}

static void
yc_set_property (GObject * o, guint id, const GValue * v, GParamSpec * p)
{
  GstYuvConv *self = (GstYuvConv *) o;
  switch (id) {
    case PROP_DROP_DUPS: self->drop_dups = g_value_get_boolean (v); break;
    case PROP_HEARTBEAT_MS: self->heartbeat_ms = g_value_get_uint (v); break;
    case PROP_LOG_EVERY: self->log_every = g_value_get_uint (v); break;
    case PROP_KEYFRAME_MS: self->keyframe_ms = g_value_get_uint (v); break;
    case PROP_ACTIVE_MS: self->active_ms = g_value_get_uint (v); break;
    default: G_OBJECT_WARN_INVALID_PROPERTY_ID (o, id, p);
  }
}

static void
yc_get_property (GObject * o, guint id, GValue * v, GParamSpec * p)
{
  GstYuvConv *self = (GstYuvConv *) o;
  switch (id) {
    case PROP_DROP_DUPS: g_value_set_boolean (v, self->drop_dups); break;
    case PROP_HEARTBEAT_MS: g_value_set_uint (v, self->heartbeat_ms); break;
    case PROP_LOG_EVERY: g_value_set_uint (v, self->log_every); break;
    case PROP_KEYFRAME_MS: g_value_set_uint (v, self->keyframe_ms); break;
    case PROP_ACTIVE_MS: g_value_set_uint (v, self->active_ms); break;
    default: G_OBJECT_WARN_INVALID_PROPERTY_ID (o, id, p);
  }
}

static void
yc_finalize (GObject * o)
{
  GstYuvConv *self = (GstYuvConv *) o;
  gst_buffer_replace (&self->prev, NULL);
  G_OBJECT_CLASS (gst_yuv_conv_parent_class)->finalize (o);
}

static void
gst_yuv_conv_class_init (GstYuvConvClass * k)
{
  GObjectClass *go = G_OBJECT_CLASS (k);
  GstElementClass *ek = GST_ELEMENT_CLASS (k);
  GstBaseTransformClass *bt = GST_BASE_TRANSFORM_CLASS (k);
  GstVideoFilterClass *vf = GST_VIDEO_FILTER_CLASS (k);
  go->set_property = yc_set_property;
  go->get_property = yc_get_property;
  go->finalize = yc_finalize;
  g_object_class_install_property (go, PROP_DROP_DUPS, g_param_spec_boolean ("drop-duplicates", "drop duplicates",
          "drop frames identical to the previous one (variable frame rate)", FALSE, G_PARAM_READWRITE));
  g_object_class_install_property (go, PROP_HEARTBEAT_MS, g_param_spec_uint ("heartbeat-ms", "heartbeat ms",
          "with drop-duplicates, still pass one frame at least this often", 0, 60000, 1000, G_PARAM_READWRITE));
  g_object_class_install_property (go, PROP_LOG_EVERY, g_param_spec_uint ("log-every", "log every",
          "print counters to stderr every N input frames (0 = never)", 0, G_MAXUINT, 0, G_PARAM_READWRITE));
  g_object_class_install_property (go, PROP_KEYFRAME_MS, g_param_spec_uint ("keyframe-ms", "keyframe ms",
          "with drop-duplicates, force a keyframe at least this often in stream time (0 = never)", 0, 600000, 0, G_PARAM_READWRITE));
  g_object_class_install_property (go, PROP_ACTIVE_MS, g_param_spec_uint ("active-ms", "active ms",
          "with drop-duplicates, pass every frame for this long after the last change (0 = drop at once)", 0, 60000, 0, G_PARAM_READWRITE));
  gst_element_class_add_static_pad_template (ek, &sink_t);
  gst_element_class_add_static_pad_template (ek, &src_t);
  gst_element_class_set_static_metadata (ek, "libyuv colorspace converter", "Filter/Converter/Video",
      "BGRx/BGRA to I420/NV12 via libyuv, optional duplicate-frame dropping", "bench");
  bt->transform_caps = yc_transform_caps;
  bt->stop = yc_stop;
  bt->passthrough_on_same_caps = FALSE;
  vf->transform_frame = yc_transform_frame;
}

static void
gst_yuv_conv_init (GstYuvConv * self)
{
  self->heartbeat_ms = 1000;
  self->last_out_pts = GST_CLOCK_TIME_NONE;
  self->last_kf_pts = GST_CLOCK_TIME_NONE;
  self->last_change_pts = GST_CLOCK_TIME_NONE;
}

static gboolean
plugin_init (GstPlugin * p)
{
  return gst_element_register (p, "yuvconv", GST_RANK_NONE, gst_yuv_conv_get_type ());
}

/* "unknown" is GStreamer's value for a license outside its list: this plugin is Apache-2.0, as the header says. */
GST_PLUGIN_DEFINE (GST_VERSION_MAJOR, GST_VERSION_MINOR, yuvconv, "libyuv colorspace converter", plugin_init,
    VERSION, "unknown", PACKAGE, "local")
