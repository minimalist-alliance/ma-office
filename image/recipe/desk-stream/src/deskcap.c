/* SPDX-License-Identifier: Apache-2.0 */
/* deskcap: the desk's X screen as NV12, captured only when something on it changes (ADR 0073, desk-runtime.md 8.2).
 *
 * Elements in this plugin:
 *   deskcap     a live source. XDamage on the root window says when and where the screen changed; only those
 *               rectangles are read over MIT-SHM, compared with the last picture, and converted to NV12 with libyuv.
 *               A still screen costs no grab, no conversion and no encode. Motion runs at up to max-fps, and the first
 *               changed frame after a still spell is grabbed the moment its damage arrives, never on a later tick.
 *   framemeter  a passthrough after the encoder: frames, bytes and capture-to-encoded latency, for desk-stream's
 *               contention control (lever 3) and for measurement.
 *
 * deskcap's output is BT.601 limited range, as yuvconv's (libyuv ARGBToNV12), and its caps say so. Buffers carry their
 * capture instant on the pipeline clock as PTS (running time), which desk-stream keeps on CLOCK_MONOTONIC (ADR 0037).
 *
 * What still sends a frame on a still screen:
 *   - "refresh" (an action signal): desk-stream emits it with every keyframe request, so a PLI, a new viewer, a resume or
 *     a level change gets its keyframe at once instead of waiting for the screen to change;
 *   - a heartbeat, a repeat of the last picture, so a browser's receiver neither counts a freeze (a frame later than
 *     max(3 x avg, avg + 150 ms), avg over its last 30 frames: the webrtc-stats freezeCount rule) nor asks for a keyframe
 *     (no frame in 3 s). Each gap stays under 0.8 of that bound, and under heartbeat-max-ms: about 130 ms right after
 *     motion, growing to heartbeat-max-ms in about 15 s of stillness. A page that changes twice a second needs none.
 *     A repeat costs no grab and no conversion, and x264 codes it as skips.
 *
 * Build: gcc -O2 -Wall -shared -fPIC -o libgstdeskcap.so deskcap.c \
 *          $(pkg-config --cflags --libs gstreamer-video-1.0 gstreamer-base-1.0 x11 xext xdamage xfixes) -lyuv
 */
#define _GNU_SOURCE             /* ppoll, pipe2 */
#include <gst/gst.h>
#include <gst/base/gstpushsrc.h>
#include <gst/base/gstbasetransform.h>
#include <gst/video/video.h>
#include <X11/Xlib.h>
#include <X11/Xutil.h>
#include <X11/extensions/XShm.h>
#include <X11/extensions/Xdamage.h>
#include <X11/extensions/Xfixes.h>
#include <sys/ipc.h>
#include <sys/shm.h>
#include <sys/socket.h>
#include <poll.h>
#include <fcntl.h>
#include <errno.h>
#include <unistd.h>
#include <string.h>
#include <time.h>
#include <libyuv.h>

#define PACKAGE "deskcap"
#define VERSION "0.3.0"

#define NSLOTS 4                /* output buffers: one being encoded, one queued, one being filled, one spare */
#define NGAPS 30                /* the receiver's freeze rule averages the last 30 frame durations */
#define MAX_RECTS 4             /* more damaged rectangles than this are grabbed as their bounding box */
#define FULL_GRAB_SHARE 0.5     /* a bounding box over half the screen is grabbed whole, in one request */
#define FREEZE_SLACK_NS (150 * GST_MSECOND)
#define HB_MIN_NS (100 * GST_MSECOND)
#define BURST 2.0               /* frames of credit: a paint that lands a little early is grabbed at once, not a tick later */

/* ------------------------------------------------------------------------------------------------------------------ */
/* deskcap */

typedef struct
{
  gint x, y, w, h;
} Box;

#define SLOT_BOXES 8
typedef struct
{
  gint refs;                    /* the element holds one; a buffer downstream holds one */
  guint8 *data;                 /* an NV12 picture, converted straight from the screen: no master copy to memcpy from */
  gint nbox;                    /* what changed on the screen since this slot last matched it; more than SLOT_BOXES */
  Box box[SLOT_BOXES];          /* boxes become their bounding box */
} Slot;

typedef struct _GstDeskCap
{
  GstPushSrc parent;

  gchar *display_name;
  gint max_fps;                 /* atomic: desk-stream lowers it under contention */
  guint heartbeat_max_ms;
  gboolean use_damage;

  Display *dpy;
  Window root;
  Visual *visual;
  gint depth;
  gint width, height;
  XImage *img[2];               /* two full-screen shared-memory images: cur is the screen as last grabbed, the other scratch */
  XShmSegmentInfo shm[2];
  gint cur;
  gboolean have_damage;
  gint damage_base;
  Damage damage;
  XserverRegion region;

  GstVideoInfo info;
  Slot *slots[NSLOTS];
  GMutex slot_lock;

  gint wake[2];
  gint flushing;                /* atomic */
  gint refresh;                 /* atomic */
  gboolean need_full;
  gboolean damage_pending;
  guint32 damage_ms;            /* server time of the first damage not yet grabbed */
  GstClockTime damage_seen;     /* running time we first saw it */

  GstClockTime last_push;
  gdouble credit;               /* pacing: a token bucket at max-fps, so the rate is capped without phase-locking behind */
  GstClockTime credit_t;        /* the paints (a fixed min gap after each grab keeps any lag a jittery paint once caused) */
  GstClockTime gaps[NGAPS];
  guint ngaps, gap_i;
  GstClockTime gap_sum;
  gint64 create_exit_us;        /* when the last create() returned, to time the push that followed */

  GMutex stats_lock;
  guint64 n_frames, n_changed, n_repeat, n_refresh, n_late, n_same;
  guint64 grab_us, cmp_us, conv_us, push_us, wait_us, changed_px;
  guint64 dmg_lat_us, dmg_lat_n, dmg_lat_max_us;
} GstDeskCap;

typedef struct
{
  GstPushSrcClass parent_class;
} GstDeskCapClass;

GType gst_desk_cap_get_type (void);
G_DEFINE_TYPE (GstDeskCap, gst_desk_cap, GST_TYPE_PUSH_SRC);
#define DESK_CAP(o) ((GstDeskCap *)(o))

enum
{ PROP_0, PROP_DISPLAY, PROP_MAX_FPS, PROP_HEARTBEAT_MAX_MS, PROP_USE_DAMAGE, PROP_STATS };
enum
{ SIGNAL_REFRESH, N_SIGNALS };
static guint dc_signals[N_SIGNALS];

static GstStaticPadTemplate dc_src_t = GST_STATIC_PAD_TEMPLATE ("src", GST_PAD_SRC, GST_PAD_ALWAYS,
    GST_STATIC_CAPS ("video/x-raw, format=NV12, width=[2,16384], height=[2,16384], framerate=[1/1,240/1]"));

static gint x_error;
static int
dc_x_error (Display * d, XErrorEvent * e)
{
  x_error = e->error_code;
  return 0;
}

static gint64
mono_us (void)
{
  return g_get_monotonic_time ();
}

static GstClockTime
dc_now (GstDeskCap * self)
{
  GstClock *clock = gst_element_get_clock (GST_ELEMENT (self));
  GstClockTime t;
  if (!clock)
    return (GstClockTime) g_get_monotonic_time () * 1000;
  t = gst_clock_get_time (clock);
  gst_object_unref (clock);
  return t - GST_ELEMENT (self)->base_time;
}

static void
slot_unref (gpointer p)
{
  Slot *s = p;
  if (g_atomic_int_dec_and_test (&s->refs)) {
    g_free (s->data);
    g_free (s);
  }
}

static void
slot_mark (Slot * s, const Box * b)
{
  gint i, x0, y0, x1, y1;
  if (s->nbox < SLOT_BOXES) {
    s->box[s->nbox++] = *b;
    return;
  }
  x0 = b->x;
  y0 = b->y;
  x1 = b->x + b->w;
  y1 = b->y + b->h;
  for (i = 0; i < s->nbox; i++) {
    x0 = MIN (x0, s->box[i].x);
    y0 = MIN (y0, s->box[i].y);
    x1 = MAX (x1, s->box[i].x + s->box[i].w);
    y1 = MAX (y1, s->box[i].y + s->box[i].h);
  }
  s->nbox = 1;
  s->box[0].x = x0;
  s->box[0].y = y0;
  s->box[0].w = x1 - x0;
  s->box[0].h = y1 - y0;
}

static void
free_shm (GstDeskCap * self, gint i)
{
  if (self->img[i]) {
    XShmDetach (self->dpy, &self->shm[i]);
    XSync (self->dpy, False);
    XDestroyImage (self->img[i]);
    shmdt (self->shm[i].shmaddr);
    self->img[i] = NULL;
  }
}

static gboolean
make_shm (GstDeskCap * self, gint i)
{
  XImage *im = XShmCreateImage (self->dpy, self->visual, self->depth, ZPixmap, NULL, &self->shm[i], self->width,
      self->height);
  if (!im)
    return FALSE;
  self->shm[i].shmid = shmget (IPC_PRIVATE, (size_t) im->bytes_per_line * im->height, IPC_CREAT | 0600);
  if (self->shm[i].shmid < 0) {
    XDestroyImage (im);
    return FALSE;
  }
  {
    /* The X server writes the screen into it, and on a desk it runs as kiosk, not root. So the segment is shared with the
     * server's own group, read from the X socket, and no one else: 0660, where ximagesrc (0.2.4) makes its segments 0777.
     * Over TCP there's no peer to ask, and only then is it 0666. */
    struct ucred cr;
    socklen_t len = sizeof cr;
    struct shmid_ds ds;
    if (shmctl (self->shm[i].shmid, IPC_STAT, &ds) == 0) {
      if (getsockopt (ConnectionNumber (self->dpy), SOL_SOCKET, SO_PEERCRED, &cr, &len) == 0 && len == sizeof cr) {
        ds.shm_perm.gid = cr.gid;
        ds.shm_perm.mode = 0660;
      } else {
        ds.shm_perm.mode = 0666;
      }
      shmctl (self->shm[i].shmid, IPC_SET, &ds);
    }
  }
  self->shm[i].shmaddr = im->data = shmat (self->shm[i].shmid, NULL, 0);
  shmctl (self->shm[i].shmid, IPC_RMID, NULL);  /* freed when the last attach goes, a crash included */
  if (im->data == (char *) -1) {
    im->data = NULL;
    XDestroyImage (im);
    return FALSE;
  }
  self->shm[i].readOnly = False;
  x_error = 0;
  if (!XShmAttach (self->dpy, &self->shm[i]) || (XSync (self->dpy, False), x_error)) {
    shmdt (self->shm[i].shmaddr);
    im->data = NULL;
    XDestroyImage (im);
    return FALSE;
  }
  self->img[i] = im;
  return TRUE;
}

static void
dc_close (GstDeskCap * self)
{
  gint i;
  if (self->dpy) {
    if (self->have_damage) {
      XDamageDestroy (self->dpy, self->damage);
      XFixesDestroyRegion (self->dpy, self->region);
      self->have_damage = FALSE;
    }
    free_shm (self, 0);
    free_shm (self, 1);
    XCloseDisplay (self->dpy);
    self->dpy = NULL;
  }
  g_mutex_lock (&self->slot_lock);
  for (i = 0; i < NSLOTS; i++) {
    if (self->slots[i])
      slot_unref (self->slots[i]);
    self->slots[i] = NULL;
  }
  g_mutex_unlock (&self->slot_lock);
}

static gboolean
dc_start (GstBaseSrc * bs)
{
  GstDeskCap *self = DESK_CAP (bs);
  XWindowAttributes wa;
  int shm_major, shm_minor, ev, er;
  Bool pixmaps;
  gint i;

  XSetErrorHandler (dc_x_error);
  self->dpy = XOpenDisplay (self->display_name);
  if (!self->dpy) {
    GST_ELEMENT_ERROR (self, RESOURCE, OPEN_READ, ("can't open X display %s", GST_STR_NULL (self->display_name)), (NULL));
    return FALSE;
  }
  self->root = DefaultRootWindow (self->dpy);
  XGetWindowAttributes (self->dpy, self->root, &wa);
  self->visual = wa.visual;
  self->depth = wa.depth;
  self->width = wa.width & ~1;
  self->height = wa.height & ~1;
  if (!XShmQueryVersion (self->dpy, &shm_major, &shm_minor, &pixmaps) || !make_shm (self, 0) || !make_shm (self, 1)) {
    GST_ELEMENT_ERROR (self, RESOURCE, OPEN_READ, ("X has no usable MIT-SHM"), (NULL));
    dc_close (self);
    return FALSE;
  }
  if (self->img[0]->bits_per_pixel != 32 || self->img[0]->byte_order != LSBFirst || self->visual->red_mask != 0xff0000) {
    GST_ELEMENT_ERROR (self, RESOURCE, OPEN_READ, ("the X screen isn't 32-bit BGRx"), (NULL));
    dc_close (self);
    return FALSE;
  }
  self->cur = 0;
  self->have_damage = FALSE;
  if (self->use_damage && XDamageQueryExtension (self->dpy, &ev, &er) && XFixesQueryExtension (self->dpy, &i, &i)) {
    self->damage_base = ev;
    self->damage = XDamageCreate (self->dpy, self->root, XDamageReportNonEmpty);
    self->region = XFixesCreateRegion (self->dpy, NULL, 0);
    self->have_damage = TRUE;
  } else {
    GST_WARNING_OBJECT (self, "no XDamage: grabbing every frame interval and comparing");
  }
  XSync (self->dpy, False);

  gst_video_info_set_format (&self->info, GST_VIDEO_FORMAT_NV12, self->width, self->height);
  for (i = 0; i < NSLOTS; i++) {
    Slot *s = g_new0 (Slot, 1);
    Box all = { 0, 0, self->width, self->height };
    s->refs = 1;
    s->data = g_malloc0 (self->info.size);
    slot_mark (s, &all);
    self->slots[i] = s;
  }
  self->need_full = TRUE;
  self->damage_pending = FALSE;
  self->last_push = self->credit_t = GST_CLOCK_TIME_NONE;
  self->ngaps = self->gap_i = 0;
  self->gap_sum = 0;
  self->create_exit_us = 0;
  return TRUE;
}

static gboolean
dc_stop (GstBaseSrc * bs)
{
  dc_close (DESK_CAP (bs));
  return TRUE;
}

static GstCaps *
dc_get_caps (GstBaseSrc * bs, GstCaps * filter)
{
  GstDeskCap *self = DESK_CAP (bs);
  GstCaps *caps;
  if (!self->dpy)
    return gst_pad_get_pad_template_caps (GST_BASE_SRC_PAD (bs));
  caps = gst_caps_new_simple ("video/x-raw", "format", G_TYPE_STRING, "NV12", "width", G_TYPE_INT, self->width,
      "height", G_TYPE_INT, self->height, "framerate", GST_TYPE_FRACTION, g_atomic_int_get (&self->max_fps), 1,
      "pixel-aspect-ratio", GST_TYPE_FRACTION, 1, 1, "colorimetry", G_TYPE_STRING, "bt601",
      "interlace-mode", G_TYPE_STRING, "progressive", NULL);
  if (filter) {
    GstCaps *t = gst_caps_intersect_full (filter, caps, GST_CAPS_INTERSECT_FIRST);
    gst_caps_unref (caps);
    caps = t;
  }
  return caps;
}

static gboolean
dc_unlock (GstBaseSrc * bs)
{
  GstDeskCap *self = DESK_CAP (bs);
  g_atomic_int_set (&self->flushing, 1);
  if (write (self->wake[1], "u", 1) < 0) {
    /* the pipe is full, so the waiter wakes anyway */
  }
  return TRUE;
}

static gboolean
dc_unlock_stop (GstBaseSrc * bs)
{
  GstDeskCap *self = DESK_CAP (bs);
  char b[64];
  g_atomic_int_set (&self->flushing, 0);
  while (read (self->wake[0], b, sizeof b) > 0);
  return TRUE;
}

static void
dc_refresh (GstDeskCap * self)
{
  g_atomic_int_set (&self->refresh, 1);
  if (write (self->wake[1], "r", 1) < 0) {
    /* already awake */
  }
}

/* Pending X events: a damage notify marks the screen changed. Nothing else is selected. */
static void
drain_x (GstDeskCap * self, GstClockTime now)
{
  while (XPending (self->dpy)) {
    XEvent e;
    XNextEvent (self->dpy, &e);
    if (self->have_damage && e.type == self->damage_base + XDamageNotify) {
      if (!self->damage_pending) {
        self->damage_pending = TRUE;
        self->damage_ms = (guint32) ((XDamageNotifyEvent *) & e)->timestamp;
        self->damage_seen = now;
      }
    }
  }
}

/* The longest a still screen may go without a repeat: 0.8 x the receiver's freeze bound, max(3 x avg, avg + 150 ms) over
 * the last 30 frame gaps, leaving room for network jitter, and never over heartbeat-max-ms. */
static GstClockTime
heartbeat_gap (GstDeskCap * self)
{
  GstClockTime avg = self->ngaps ? self->gap_sum / self->ngaps : 16 * GST_MSECOND;
  GstClockTime g = MAX (3 * avg, avg + FREEZE_SLACK_NS) * 8 / 10;
  GstClockTime cap = (GstClockTime) self->heartbeat_max_ms * GST_MSECOND;
  return MAX (HB_MIN_NS, MIN (g, cap));
}

static void
record_gap (GstDeskCap * self, GstClockTime pts)
{
  if (GST_CLOCK_TIME_IS_VALID (self->last_push) && pts > self->last_push) {
    GstClockTime g = pts - self->last_push;
    if (self->ngaps == NGAPS)
      self->gap_sum -= self->gaps[self->gap_i];
    else
      self->ngaps++;
    self->gaps[self->gap_i] = g;
    self->gap_sum += g;
    self->gap_i = (self->gap_i + 1) % NGAPS;
  }
  self->last_push = pts;
}

/* The first and last rows of b that differ between the scratch rows (stride sstride) and the current picture, or FALSE.
 * Scans down to the first difference and up to the last, so a frame that moved costs two row compares, not a whole one. */
static gboolean
changed_rows (GstDeskCap * self, const guint8 * src, gint sstride, const Box * b, gint * first, gint * last)
{
  const XImage *cur = self->img[self->cur];
  gint f, l;
  gsize n = (gsize) b->w * 4;
#define ROW_DIFFERS(row) (memcmp (src + (gsize) (row) * sstride, (const guint8 *) cur->data + \
      (gsize) (b->y + (row)) * cur->bytes_per_line + (gsize) b->x * 4, n) != 0)
  for (f = 0; f < b->h && !ROW_DIFFERS (f); f++);
  if (f == b->h)
    return FALSE;
  for (l = b->h - 1; l > f && !ROW_DIFFERS (l); l--);
#undef ROW_DIFFERS
  *first = f;
  *last = l;
  return TRUE;
}

static void
convert_box (GstDeskCap * self, guint8 * dst, const Box * b)
{
  const XImage *cur = self->img[self->cur];
  gint ys = GST_VIDEO_INFO_PLANE_STRIDE (&self->info, 0), uvs = GST_VIDEO_INFO_PLANE_STRIDE (&self->info, 1);
  guint8 *py = dst + GST_VIDEO_INFO_PLANE_OFFSET (&self->info, 0);
  guint8 *puv = dst + GST_VIDEO_INFO_PLANE_OFFSET (&self->info, 1);
  ARGBToNV12 ((const uint8_t *) cur->data + (gsize) b->y * cur->bytes_per_line + (gsize) b->x * 4, cur->bytes_per_line,
      py + (gsize) b->y * ys + b->x, ys, puv + (gsize) (b->y / 2) * uvs + b->x, uvs, b->w, b->h);
}

/* Even-aligned and clipped to the screen, as NV12's 2x2 chroma needs. */
static gboolean
even_box (GstDeskCap * self, gint x, gint y, gint w, gint h, Box * b)
{
  gint x0 = MAX (0, x) & ~1, y0 = MAX (0, y) & ~1;
  gint x1 = MIN (self->width, x + w), y1 = MIN (self->height, y + h);
  x1 = MIN (self->width, (x1 + 1) & ~1);
  y1 = MIN (self->height, (y1 + 1) & ~1);
  if (x1 <= x0 || y1 <= y0)
    return FALSE;
  b->x = x0;
  b->y = y0;
  b->w = x1 - x0;
  b->h = y1 - y0;
  return TRUE;
}

/* Reads what changed into the current picture and marks every slot with it. TRUE if any pixel changed. */
static gboolean
grab (GstDeskCap * self)
{
  Box boxes[MAX_RECTS], changed[MAX_RECTS];
  gint nb = 0, nc = 0, i;
  gboolean full = self->need_full || !self->have_damage;
  gint64 t0, t1 = 0;
  guint64 cmp = 0, px = 0;

  t0 = mono_us ();
  if (!full) {
    XRectangle *r;
    int n = 0;
    XDamageSubtract (self->dpy, self->damage, None, self->region);
    r = XFixesFetchRegion (self->dpy, self->region, &n);
    if (r && n > 0) {
      gint bx0 = G_MAXINT, by0 = G_MAXINT, bx1 = 0, by1 = 0;
      for (i = 0; i < n; i++) {
        bx0 = MIN (bx0, r[i].x);
        by0 = MIN (by0, r[i].y);
        bx1 = MAX (bx1, r[i].x + r[i].width);
        by1 = MAX (by1, r[i].y + r[i].height);
      }
      if ((gdouble) (bx1 - bx0) * (by1 - by0) > FULL_GRAB_SHARE * self->width * self->height)
        full = TRUE;
      else if (n > MAX_RECTS) {
        if (even_box (self, bx0, by0, bx1 - bx0, by1 - by0, &boxes[0]))
          nb = 1;
      } else {
        for (i = 0; i < n; i++)
          if (even_box (self, r[i].x, r[i].y, r[i].width, r[i].height, &boxes[nb]))
            nb++;
      }
    }
    if (r)
      XFree (r);
    t1 = mono_us ();
    if (!full && nb == 0) {
      self->damage_pending = FALSE;
      return FALSE;
    }
  } else if (self->have_damage) {
    XDamageSubtract (self->dpy, self->damage, None, None);
  }

  if (full) {
    XImage *scr = self->img[!self->cur];
    gint f = 0, l = self->height - 1;
    x_error = 0;
    if (!XShmGetImage (self->dpy, self->root, scr, 0, 0, AllPlanes) || x_error) {
      GST_WARNING_OBJECT (self, "XShmGetImage failed (%d)", x_error);
      return FALSE;
    }
    t1 = mono_us ();
    if (!self->need_full) {
      Box all = { 0, 0, self->width, self->height };
      if (!changed_rows (self, (const guint8 *) scr->data, scr->bytes_per_line, &all, &f, &l)) {
        cmp += mono_us () - t1;
        self->damage_pending = FALSE;
        g_mutex_lock (&self->stats_lock);
        self->grab_us += t1 - t0;
        self->cmp_us += cmp;
        self->n_same++;
        g_mutex_unlock (&self->stats_lock);
        return FALSE;
      }
    }
    cmp += mono_us () - t1;
    self->cur = !self->cur;       /* the scratch is now the screen: no copy */
    f &= ~1;
    l = MIN (self->height - 1, l | 1);
    changed[0].x = 0;
    changed[0].y = f;
    changed[0].w = self->width;
    changed[0].h = l - f + 1;
    nc = 1;
  } else {
    XImage *scr = self->img[!self->cur], sub;
    XImage *cur = self->img[self->cur];
    gint64 tg = 0;
    for (i = 0; i < nb; i++) {
      const Box *b = &boxes[i];
      gint f, l, y;
      gint64 a = mono_us (), c;
      sub = *scr;
      sub.width = b->w;
      sub.height = b->h;
      sub.bytes_per_line = b->w * 4;
      x_error = 0;
      if (!XShmGetImage (self->dpy, self->root, &sub, b->x, b->y, AllPlanes) || x_error) {
        GST_WARNING_OBJECT (self, "XShmGetImage of %dx%d+%d+%d failed (%d)", b->w, b->h, b->x, b->y, x_error);
        continue;
      }
      c = mono_us ();
      tg += c - a;
      if (changed_rows (self, (const guint8 *) scr->data, sub.bytes_per_line, b, &f, &l)) {
        f &= ~1;
        l = MIN (b->h - 1, l | 1);
        for (y = f; y <= l; y++)
          memcpy ((guint8 *) cur->data + (gsize) (b->y + y) * cur->bytes_per_line + (gsize) b->x * 4,
              (const guint8 *) scr->data + (gsize) y * sub.bytes_per_line, (gsize) b->w * 4);
        changed[nc].x = b->x;
        changed[nc].y = b->y + f;
        changed[nc].w = b->w;
        changed[nc].h = l - f + 1;
        nc++;
      }
      cmp += mono_us () - c;
    }
    t1 = t1 + tg;
  }
  self->need_full = FALSE;
  self->damage_pending = FALSE;
  if (nc == 0) {
    g_mutex_lock (&self->stats_lock);
    self->grab_us += t1 - t0;
    self->cmp_us += cmp;
    self->n_same++;
    g_mutex_unlock (&self->stats_lock);
    return FALSE;
  }
  for (i = 0; i < nc; i++)
    px += (guint64) changed[i].w * changed[i].h;
  g_mutex_lock (&self->slot_lock);
  for (i = 0; i < nc; i++) {
    gint s;
    for (s = 0; s < NSLOTS; s++)
      slot_mark (self->slots[s], &changed[i]);
  }
  g_mutex_unlock (&self->slot_lock);
  g_mutex_lock (&self->stats_lock);
  self->grab_us += t1 - t0;
  self->cmp_us += cmp;
  self->changed_px += px;
  g_mutex_unlock (&self->stats_lock);
  return TRUE;
}

static gint64
slot_area (const Slot * s)
{
  gint64 a = 0;
  gint i;
  for (i = 0; i < s->nbox; i++)
    a += (gint64) s->box[i].w * s->box[i].h;
  return a;
}

/* The screen as NV12 in a free slot: only what changed since that slot was last sent is converted into it. */
static GstBuffer *
make_buffer (GstDeskCap * self)
{
  Slot *s = NULL;
  gint i;
  gint64 t0 = mono_us ();
  GstBuffer *buf;
  gsize size = self->info.size;

  g_mutex_lock (&self->slot_lock);
  for (i = 0; i < NSLOTS; i++) {
    Slot *c = self->slots[i];
    if (g_atomic_int_get (&c->refs) != 1)
      continue;                 /* downstream still has it */
    if (!s || slot_area (c) < slot_area (s))
      s = c;
  }
  if (s) {
    for (i = 0; i < s->nbox; i++)
      convert_box (self, s->data, &s->box[i]);
    s->nbox = 0;
    g_atomic_int_inc (&s->refs);
    g_mutex_unlock (&self->slot_lock);
    buf = gst_buffer_new_wrapped_full (GST_MEMORY_FLAG_READONLY, s->data, size, 0, size, s, slot_unref);
  } else {
    /* All four downstream at once (a stalled encoder): a fresh picture, whole. */
    Box all = { 0, 0, self->width, self->height };
    GstMapInfo m;
    g_mutex_unlock (&self->slot_lock);
    buf = gst_buffer_new_allocate (NULL, size, NULL);
    gst_buffer_map (buf, &m, GST_MAP_WRITE);
    convert_box (self, m.data, &all);
    gst_buffer_unmap (buf, &m);
  }
  g_mutex_lock (&self->stats_lock);
  self->conv_us += mono_us () - t0;
  g_mutex_unlock (&self->stats_lock);
  return buf;
}

static GstFlowReturn
dc_create (GstPushSrc * ps, GstBuffer ** outbuf)
{
  GstDeskCap *self = DESK_CAP (ps);
  gint64 entered = mono_us ();
  gint64 waited = 0;
  struct pollfd fds[2];

  if (self->create_exit_us) {
    g_mutex_lock (&self->stats_lock);
    self->push_us += entered - self->create_exit_us;
    g_mutex_unlock (&self->stats_lock);
  }
  fds[0].fd = ConnectionNumber (self->dpy);
  fds[0].events = POLLIN;
  fds[1].fd = self->wake[0];
  fds[1].events = POLLIN;

  for (;;) {
    GstClockTime now, interval, due = GST_CLOCK_TIME_NONE;
    gboolean refresh, want, hb = FALSE;
    gint fps;

    if (g_atomic_int_get (&self->flushing)) {
      self->need_full = TRUE;   /* a pause: the screen may have changed in ways the damage won't say */
      self->create_exit_us = 0;
      self->last_push = self->credit_t = GST_CLOCK_TIME_NONE;       /* a resume starts a new timeline */
      self->ngaps = self->gap_i = 0;
      self->gap_sum = 0;
      return GST_FLOW_FLUSHING;
    }
    now = dc_now (self);
    if (self->have_damage)
      drain_x (self, now);
    fps = MAX (1, g_atomic_int_get (&self->max_fps));
    interval = GST_SECOND / fps;
    if (GST_CLOCK_TIME_IS_VALID (self->credit_t) && now > self->credit_t)
      self->credit = MIN (BURST, self->credit + (gdouble) (now - self->credit_t) * fps / GST_SECOND);
    else if (!GST_CLOCK_TIME_IS_VALID (self->credit_t))
      self->credit = BURST;
    self->credit_t = now;
    refresh = g_atomic_int_get (&self->refresh);
    want = self->need_full || self->damage_pending || !self->have_damage;
    if (self->heartbeat_max_ms && GST_CLOCK_TIME_IS_VALID (self->last_push))
      hb = now >= self->last_push + heartbeat_gap (self);

    if (want || refresh || hb) {
      /* Every grab and every frame sent costs one credit, so nothing outruns max-fps, an unchanged repaint included. */
      if (self->credit >= 1.0) {
        GstClockTime pts = now;
        gboolean changed = FALSE;
        self->credit -= 1.0;
        if (want) {
          gboolean was_pending = self->damage_pending;
          guint32 dms = self->damage_ms;
          GstClockTime seen = self->damage_seen;
          changed = grab (self);
          if (changed && was_pending) {
            /* Late: the grab started more than a frame interval after it could have. The damage's own time is the X
             * server's timestamp, CLOCK_MONOTONIC in ms on Xorg and Xvfb as our clock is, so a starved thread that
             * noticed the damage late still counts it; if the two clocks disagree, the time we saw it stands in. */
            gint64 lat = (gint64) ((guint32) (now / GST_MSECOND) - dms);
            GstClockTime at = (lat >= 0 && lat < 10000 && now >= (GstClockTime) lat * GST_MSECOND) ?
                now - (GstClockTime) lat * GST_MSECOND : seen;
            g_mutex_lock (&self->stats_lock);
            if (now > at + interval)
              self->n_late++;
            if (lat >= 0 && lat < 10000) {
              self->dmg_lat_us += (guint64) lat * 1000;
              self->dmg_lat_n++;
              self->dmg_lat_max_us = MAX (self->dmg_lat_max_us, (guint64) lat * 1000);
            }
            g_mutex_unlock (&self->stats_lock);
          }
        }
        if (changed || refresh || hb) {
          GstBuffer *buf;
          if (refresh)
            g_atomic_int_set (&self->refresh, 0);
          buf = make_buffer (self);
          GST_BUFFER_PTS (buf) = pts;
          GST_BUFFER_DTS (buf) = GST_CLOCK_TIME_NONE;
          GST_BUFFER_DURATION (buf) = GST_CLOCK_TIME_NONE;
          record_gap (self, pts);
          g_mutex_lock (&self->stats_lock);
          self->n_frames++;
          if (changed)
            self->n_changed++;
          else if (refresh)
            self->n_refresh++;
          else
            self->n_repeat++;
          self->wait_us += waited;
          g_mutex_unlock (&self->stats_lock);
          *outbuf = buf;
          self->create_exit_us = mono_us ();
          return GST_FLOW_OK;
        }
        continue;               /* damage, but nothing changed: back to waiting */
      }
      due = now + (GstClockTime) ((1.0 - self->credit) * interval) + 1;
    }
    if (!GST_CLOCK_TIME_IS_VALID (due) && self->heartbeat_max_ms && GST_CLOCK_TIME_IS_VALID (self->last_push))
      due = self->last_push + heartbeat_gap (self);

    {
      struct timespec ts, *tsp = NULL;
      gint64 w0 = mono_us ();
      if (GST_CLOCK_TIME_IS_VALID (due)) {
        GstClockTime d = due > now ? due - now : 0;
        ts.tv_sec = d / GST_SECOND;
        ts.tv_nsec = d % GST_SECOND;
        tsp = &ts;
      }
      XFlush (self->dpy);
      if (!XPending (self->dpy)) {
        if (ppoll (fds, 2, tsp, NULL) < 0 && errno != EINTR) {
          GST_ELEMENT_ERROR (self, RESOURCE, READ, ("poll failed: %s", g_strerror (errno)), (NULL));
          return GST_FLOW_ERROR;
        }
        if (fds[1].revents & POLLIN) {
          char b[64];
          while (read (self->wake[0], b, sizeof b) > 0);
        }
        if (fds[0].revents & (POLLHUP | POLLERR)) {
          GST_ELEMENT_ERROR (self, RESOURCE, READ, ("the X connection closed"), (NULL));
          return GST_FLOW_ERROR;
        }
      }
      waited += mono_us () - w0;
    }
  }
}

static gboolean
dc_query (GstBaseSrc * bs, GstQuery * q)
{
  if (GST_QUERY_TYPE (q) == GST_QUERY_LATENCY) {
    gst_query_set_latency (q, TRUE, 0, GST_CLOCK_TIME_NONE);
    return TRUE;
  }
  return GST_BASE_SRC_CLASS (gst_desk_cap_parent_class)->query (bs, q);
}

static void
dc_set_property (GObject * o, guint id, const GValue * v, GParamSpec * p)
{
  GstDeskCap *self = DESK_CAP (o);
  switch (id) {
    case PROP_DISPLAY:
      g_free (self->display_name);
      self->display_name = g_value_dup_string (v);
      break;
    case PROP_MAX_FPS:
      g_atomic_int_set (&self->max_fps, (gint) g_value_get_uint (v));
      if (self->wake[1] >= 0 && write (self->wake[1], "f", 1) < 0) {
      }
      break;
    case PROP_HEARTBEAT_MAX_MS:
      self->heartbeat_max_ms = g_value_get_uint (v);
      break;
    case PROP_USE_DAMAGE:
      self->use_damage = g_value_get_boolean (v);
      break;
    default:
      G_OBJECT_WARN_INVALID_PROPERTY_ID (o, id, p);
  }
}

static void
dc_get_property (GObject * o, guint id, GValue * v, GParamSpec * p)
{
  GstDeskCap *self = DESK_CAP (o);
  switch (id) {
    case PROP_DISPLAY:
      g_value_set_string (v, self->display_name);
      break;
    case PROP_MAX_FPS:
      g_value_set_uint (v, (guint) g_atomic_int_get (&self->max_fps));
      break;
    case PROP_HEARTBEAT_MAX_MS:
      g_value_set_uint (v, self->heartbeat_max_ms);
      break;
    case PROP_USE_DAMAGE:
      g_value_set_boolean (v, self->use_damage);
      break;
    case PROP_STATS:
      g_mutex_lock (&self->stats_lock);
      g_value_take_boxed (v, gst_structure_new ("deskcap-stats",
              "frames", G_TYPE_UINT64, self->n_frames, "changed", G_TYPE_UINT64, self->n_changed,
              "repeats", G_TYPE_UINT64, self->n_repeat, "refreshes", G_TYPE_UINT64, self->n_refresh,
              "late", G_TYPE_UINT64, self->n_late, "unchanged-grabs", G_TYPE_UINT64, self->n_same,
              "grab-us", G_TYPE_UINT64, self->grab_us, "compare-us", G_TYPE_UINT64, self->cmp_us,
              "convert-us", G_TYPE_UINT64, self->conv_us,
              "push-us", G_TYPE_UINT64, self->push_us, "wait-us", G_TYPE_UINT64, self->wait_us,
              "changed-px", G_TYPE_UINT64, self->changed_px,
              "damage-latency-us", G_TYPE_UINT64, self->dmg_lat_us, "damage-latency-n", G_TYPE_UINT64, self->dmg_lat_n,
              "damage-latency-max-us", G_TYPE_UINT64, self->dmg_lat_max_us,
              "width", G_TYPE_INT, self->width, "height", G_TYPE_INT, self->height,
              "damage", G_TYPE_BOOLEAN, self->have_damage, NULL));
      g_mutex_unlock (&self->stats_lock);
      break;
    default:
      G_OBJECT_WARN_INVALID_PROPERTY_ID (o, id, p);
  }
}

static void
dc_finalize (GObject * o)
{
  GstDeskCap *self = DESK_CAP (o);
  dc_close (self);
  g_free (self->display_name);
  if (self->wake[0] >= 0)
    close (self->wake[0]);
  if (self->wake[1] >= 0)
    close (self->wake[1]);
  g_mutex_clear (&self->slot_lock);
  g_mutex_clear (&self->stats_lock);
  G_OBJECT_CLASS (gst_desk_cap_parent_class)->finalize (o);
}

static void
gst_desk_cap_class_init (GstDeskCapClass * k)
{
  GObjectClass *go = G_OBJECT_CLASS (k);
  GstElementClass *ek = GST_ELEMENT_CLASS (k);
  GstBaseSrcClass *bs = GST_BASE_SRC_CLASS (k);
  GstPushSrcClass *ps = GST_PUSH_SRC_CLASS (k);

  go->set_property = dc_set_property;
  go->get_property = dc_get_property;
  go->finalize = dc_finalize;
  g_object_class_install_property (go, PROP_DISPLAY, g_param_spec_string ("display-name", "display name",
          "X display to capture (default: $DISPLAY)", NULL, G_PARAM_READWRITE | G_PARAM_STATIC_STRINGS));
  g_object_class_install_property (go, PROP_MAX_FPS, g_param_spec_uint ("max-fps", "max fps",
          "the most frames a second; may change while playing", 1, 240, 60,
          G_PARAM_READWRITE | GST_PARAM_MUTABLE_PLAYING | G_PARAM_STATIC_STRINGS));
  g_object_class_install_property (go, PROP_HEARTBEAT_MAX_MS, g_param_spec_uint ("heartbeat-max-ms", "heartbeat max ms",
          "on a still screen, repeat the last picture at least this often (0: never)", 0, 2500, 1000,
          G_PARAM_READWRITE | G_PARAM_STATIC_STRINGS));
  g_object_class_install_property (go, PROP_USE_DAMAGE, g_param_spec_boolean ("use-damage", "use damage",
          "capture on XDamage (FALSE: grab every frame interval and compare)", TRUE,
          G_PARAM_READWRITE | G_PARAM_STATIC_STRINGS));
  g_object_class_install_property (go, PROP_STATS, g_param_spec_boxed ("stats", "stats",
          "counters since start", GST_TYPE_STRUCTURE, G_PARAM_READABLE | G_PARAM_STATIC_STRINGS));
  dc_signals[SIGNAL_REFRESH] = g_signal_new_class_handler ("refresh", G_TYPE_FROM_CLASS (k),
      G_SIGNAL_RUN_LAST | G_SIGNAL_ACTION, G_CALLBACK (dc_refresh), NULL, NULL, NULL, G_TYPE_NONE, 0);

  gst_element_class_add_static_pad_template (ek, &dc_src_t);
  gst_element_class_set_static_metadata (ek, "Desk screen capture", "Source/Video",
      "X screen to NV12, only when it changes (XDamage, MIT-SHM, libyuv)", "Minimalist Alliance");
  bs->start = dc_start;
  bs->stop = dc_stop;
  bs->get_caps = dc_get_caps;
  bs->unlock = dc_unlock;
  bs->unlock_stop = dc_unlock_stop;
  bs->query = dc_query;
  ps->create = dc_create;
}

static void
gst_desk_cap_init (GstDeskCap * self)
{
  gst_base_src_set_live (GST_BASE_SRC (self), TRUE);
  gst_base_src_set_format (GST_BASE_SRC (self), GST_FORMAT_TIME);
  self->max_fps = 60;
  self->heartbeat_max_ms = 1000;
  self->use_damage = TRUE;
  self->last_push = GST_CLOCK_TIME_NONE;
  g_mutex_init (&self->slot_lock);
  g_mutex_init (&self->stats_lock);
  if (pipe2 (self->wake, O_NONBLOCK | O_CLOEXEC) < 0)
    self->wake[0] = self->wake[1] = -1;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* framemeter */

#define NBUCKETS 14
static const guint bucket_ms[NBUCKETS - 1] = { 2, 4, 6, 8, 10, 12, 14, 16, 20, 25, 33, 50, 100 };

typedef struct
{
  GstBaseTransform parent;
  GMutex lock;
  guint64 frames, bytes, keyframes, lat_sum_us, lat_max_us;
  guint64 hist[NBUCKETS];
} GstFrameMeter;

typedef struct
{
  GstBaseTransformClass parent_class;
} GstFrameMeterClass;

GType gst_frame_meter_get_type (void);
G_DEFINE_TYPE (GstFrameMeter, gst_frame_meter, GST_TYPE_BASE_TRANSFORM);
#define FRAME_METER(o) ((GstFrameMeter *)(o))

enum
{ FM_PROP_0, FM_PROP_STATS };

static GstStaticPadTemplate fm_sink_t = GST_STATIC_PAD_TEMPLATE ("sink", GST_PAD_SINK, GST_PAD_ALWAYS, GST_STATIC_CAPS_ANY);
static GstStaticPadTemplate fm_src_t = GST_STATIC_PAD_TEMPLATE ("src", GST_PAD_SRC, GST_PAD_ALWAYS, GST_STATIC_CAPS_ANY);

static GstFlowReturn
fm_transform_ip (GstBaseTransform * bt, GstBuffer * buf)
{
  GstFrameMeter *self = FRAME_METER (bt);
  GstClock *clock = gst_element_get_clock (GST_ELEMENT (bt));
  GstClockTime pts = GST_BUFFER_PTS (buf);
  gint64 lat = -1;
  if (clock && GST_CLOCK_TIME_IS_VALID (pts)) {
    GstClockTime now = gst_clock_get_time (clock) - GST_ELEMENT (bt)->base_time;
    GstClockTime rt = gst_segment_to_running_time (&bt->segment, GST_FORMAT_TIME, pts);
    if (GST_CLOCK_TIME_IS_VALID (rt) && now >= rt)
      lat = (gint64) ((now - rt) / 1000);
  }
  if (clock)
    gst_object_unref (clock);
  g_mutex_lock (&self->lock);
  self->frames++;
  self->bytes += gst_buffer_get_size (buf);
  if (!GST_BUFFER_FLAG_IS_SET (buf, GST_BUFFER_FLAG_DELTA_UNIT))
    self->keyframes++;
  if (lat >= 0) {
    guint b = 0;
    self->lat_sum_us += lat;
    self->lat_max_us = MAX (self->lat_max_us, (guint64) lat);
    while (b < NBUCKETS - 1 && (guint64) lat > (guint64) bucket_ms[b] * 1000)
      b++;
    self->hist[b]++;
  }
  g_mutex_unlock (&self->lock);
  return GST_FLOW_OK;
}

static void
fm_get_property (GObject * o, guint id, GValue * v, GParamSpec * p)
{
  GstFrameMeter *self = FRAME_METER (o);
  if (id == FM_PROP_STATS) {
    GstStructure *s;
    guint b;
    g_mutex_lock (&self->lock);
    s = gst_structure_new ("framemeter-stats", "frames", G_TYPE_UINT64, self->frames, "bytes", G_TYPE_UINT64,
        self->bytes, "keyframes", G_TYPE_UINT64, self->keyframes, "latency-sum-us", G_TYPE_UINT64, self->lat_sum_us,
        "latency-max-us", G_TYPE_UINT64, self->lat_max_us, NULL);
    for (b = 0; b < NBUCKETS; b++) {
      gchar name[16];
      g_snprintf (name, sizeof name, "le%u", b < NBUCKETS - 1 ? bucket_ms[b] : 0);
      gst_structure_set (s, name, G_TYPE_UINT64, self->hist[b], NULL);
    }
    g_mutex_unlock (&self->lock);
    g_value_take_boxed (v, s);
  } else {
    G_OBJECT_WARN_INVALID_PROPERTY_ID (o, id, p);
  }
}

static void
fm_finalize (GObject * o)
{
  g_mutex_clear (&FRAME_METER (o)->lock);
  G_OBJECT_CLASS (gst_frame_meter_parent_class)->finalize (o);
}

static void
gst_frame_meter_class_init (GstFrameMeterClass * k)
{
  GObjectClass *go = G_OBJECT_CLASS (k);
  GstElementClass *ek = GST_ELEMENT_CLASS (k);
  GstBaseTransformClass *bt = GST_BASE_TRANSFORM_CLASS (k);
  go->get_property = fm_get_property;
  go->finalize = fm_finalize;
  g_object_class_install_property (go, FM_PROP_STATS, g_param_spec_boxed ("stats", "stats",
          "frames, bytes, keyframes and capture-to-here latency (histogram buckets leN: up to N ms, le0: over 100)",
          GST_TYPE_STRUCTURE, G_PARAM_READABLE | G_PARAM_STATIC_STRINGS));
  gst_element_class_add_static_pad_template (ek, &fm_sink_t);
  gst_element_class_add_static_pad_template (ek, &fm_src_t);
  gst_element_class_set_static_metadata (ek, "Frame meter", "Filter",
      "Counts frames and their latency since capture, passing them through", "Minimalist Alliance");
  bt->transform_ip = fm_transform_ip;
  bt->transform_ip_on_passthrough = TRUE;
}

static void
gst_frame_meter_init (GstFrameMeter * self)
{
  g_mutex_init (&self->lock);
  gst_base_transform_set_passthrough (GST_BASE_TRANSFORM (self), TRUE);
}

static gboolean
plugin_init (GstPlugin * p)
{
  return gst_element_register (p, "deskcap", GST_RANK_NONE, gst_desk_cap_get_type ())
      && gst_element_register (p, "framemeter", GST_RANK_NONE, gst_frame_meter_get_type ());
}

/* "unknown" is GStreamer's value for a license outside its list: this plugin is Apache-2.0, as the header says. */
GST_PLUGIN_DEFINE (GST_VERSION_MAJOR, GST_VERSION_MINOR, deskcap, "desk screen capture", plugin_init, VERSION, "unknown",
    PACKAGE, "https://minimalistalliance.com")
