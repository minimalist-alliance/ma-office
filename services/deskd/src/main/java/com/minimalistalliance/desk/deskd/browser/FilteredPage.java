package com.minimalistalliance.desk.deskd.browser;

/**
 * The page a teen sees in place of Chromium's own when the family filter stopped a site ({@link FilteredSites}). It's
 * member-facing copy, so a change goes through the Product Designer's brand review (docs/sub-status/deskd-teen-block-page.md).
 *
 * <p>Colors are the Light theme's from docs/assets/brand/ui/tokens.json, and type follows docs/assets/brand/ui/type.txt:
 * its stack and its metric-adjusted fallback, which uses only fonts already on the machine, as this page can't load one.
 * The card is the office's notice ({@code .desk-notice} in web/src/styles/app.css) on the calm screen's background.
 *
 * <p>It names nothing: no site, no product, no person. Nothing in it makes a request, and its policy says so too. Its one
 * script is the button's.
 */
final class FilteredPage {

    static final String TITLE = "This site is filtered";
    static final String LINE = "Your Browser uses a family filter until you're 18.";

    static final String HTML = """
            <!doctype html>
            <html lang="en">
            <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <meta name="color-scheme" content="light">
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
            <title>%s</title>
            <style>
            @font-face {
              font-family: "Nunito Fallback";
              src: local("Arial"), local("Liberation Sans"), local("Arimo"), local("Helvetica");
              size-adjust: 102.7%%; ascent-override: 98.4%%; descent-override: 34.6%%; line-gap-override: 0%%;
            }
            html { height: 100%%; background: #E9E9E5; color: #2A2E35; }
            body {
              box-sizing: border-box; min-height: 100%%; margin: 0; padding: 16px;
              display: grid; place-items: center;
              background-image: radial-gradient(ellipse 120%% 95%% at 50%% 26%%, #F5F5F2 0%%, #E9E9E5 55%%, #DDDED9 100%%);
              font-family: "Nunito Variable", "Nunito", "Nunito Fallback", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
              font-size: 14px; line-height: 20px; font-weight: 600;
              -webkit-font-smoothing: antialiased;
            }
            main {
              box-sizing: border-box; width: min(440px, 100%%); padding: 28px;
              border: 1px solid rgba(42, 46, 53, 0.14); border-radius: 22px; background: #FDFDFB;
              box-shadow: 0 12px 32px rgba(42, 46, 53, 0.16), 0 2px 6px rgba(42, 46, 53, 0.07);
              text-align: center;
            }
            h1 { margin: 0; font-size: 24px; line-height: 32px; font-weight: 500; color: #2A2E35; }
            p { margin: 8px 0 0; font-size: 14px; line-height: 22px; font-weight: 600; color: #565A63; }
            button {
              height: 36px; min-width: 160px; margin-top: 20px; padding: 0 16px;
              border: 1px solid #5076AA; border-radius: 12px; background: #5076AA; color: #FFFFFF;
              font: inherit; font-size: 14px; font-weight: 700; cursor: pointer;
            }
            button:hover { border-color: #476B9C; background: #476B9C; }
            button:active { border-color: #3E5F8C; background: #3E5F8C; }
            button:focus-visible { outline: 2px solid #5076AA; outline-offset: 2px; }
            </style>
            </head>
            <body>
            <main>
            <h1>%s</h1>
            <p>%s</p>
            <button type="button" id="back" onclick="history.back()">Back</button>
            </main>
            <script>if (history.length < 2) document.getElementById("back").hidden = true;</script>
            </body>
            </html>
            """.formatted(TITLE, TITLE, LINE);

    private FilteredPage() {}
}
