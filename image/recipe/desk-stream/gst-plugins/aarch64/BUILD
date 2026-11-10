source-sha256 90d42fc37c078b710d795fb3197e8e97f1f6fb38d59e4b890371ce952cd9faa7
so-sha256 228d93b06b3eb26461c8fa6c2f52ba7a8efc991339681c332ea477c0f2848f94
built 2026-11-10T08:47:15Z on Debian GNU/Linux 13 (trixie), cross-compiled for aarch64 on x86_64 (docker debian:trixie, crossbuild-essential-arm64 and the arm64 -dev packages)
gcc 14.2.0
gstreamer 1.26.2
libyuv 0.0.1904.20250204-1
command PKG_CONFIG_LIBDIR=/usr/lib/aarch64-linux-gnu/pkgconfig:/usr/share/pkgconfig aarch64-linux-gnu-gcc -O2 -Wall -Wextra -Wno-unused-parameter -shared -fPIC -o libgstdeskcap.so deskcap.c $(pkg-config --cflags --libs gstreamer-video-1.0 gstreamer-base-1.0 x11 xext xdamage xfixes) -lyuv && aarch64-linux-gnu-strip --strip-unneeded libgstdeskcap.so
check the same cross build of the previous deskcap.c (source-sha256 0acabfd3...) reproduced the previous native aarch64 build (so-sha256 4068c012...) byte for byte
