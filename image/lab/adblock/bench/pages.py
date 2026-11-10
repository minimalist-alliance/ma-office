"""Local test pages for the ad-blocking checks. serve [port]: any host, /page loads a script that a generic EasyList rule blocks."""
import http.server, socketserver, sys
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 18767
AD = sys.argv[3] if len(sys.argv) > 3 else '/pogoadkit.js'
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        host = self.headers.get('Host', '')
        if self.path.startswith('/page'):
            body = ('<!doctype html><title>adtest %s</title><p id=p>page on %s</p><script>window.adran=0</script>'
                    '<script src="%s?r=%s"></script>' % (host, host, AD, self.path)).encode()
            ct = 'text/html'
        elif self.path.startswith('/frame'):
            body = ('<!doctype html><script src="%s?f=%s"></script><script>parent.postMessage({h: location.hostname, ran: window.adran || 0}, "*")</script>' % (AD, self.path)).encode()
            ct = 'text/html'
        elif self.path.startswith(AD):
            body = b'window.adran=1'; ct = 'text/javascript'
        else:
            self.send_response(404); self.end_headers(); return
        self.send_response(200); self.send_header('content-type', ct); self.send_header('cache-control', 'no-store')
        self.send_header('content-length', str(len(body))); self.end_headers(); self.wfile.write(body)
class S(socketserver.ThreadingMixIn, http.server.HTTPServer): daemon_threads = True; allow_reuse_address = True
if __name__ == '__main__':
    S(('127.0.0.1', PORT), H).serve_forever()
