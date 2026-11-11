package com.minimalistalliance.desk.deskd.browser;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.minimalistalliance.desk.deskd.rpc.RpcException;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/** Bookmarks files as Chrome, Firefox and Safari export them: the Netscape bookmark file. */
class BookmarksHtmlTest {

    private static BookmarksHtml.Parsed parse(String html) throws RpcException {
        return BookmarksHtml.parse(html.getBytes(StandardCharsets.UTF_8));
    }

    private static BookmarksHtml.Node folder(int parent, String title) {
        return new BookmarksHtml.Node(parent, true, title, null);
    }

    private static BookmarksHtml.Node link(int parent, String title, String url) {
        return new BookmarksHtml.Node(parent, false, title, url);
    }

    @Test
    void chromesExportKeepsItsFoldersInOrder() throws Exception {
        BookmarksHtml.Parsed parsed = parse("""
                <!DOCTYPE NETSCAPE-Bookmark-file-1>
                <!-- This is an automatically generated file. <DL><A HREF="https://comment.example/">no</A> -->
                <META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
                <TITLE>Bookmarks</TITLE>
                <H1>Bookmarks</H1>
                <DL><p>
                    <DT><H3 ADD_DATE="1700000000" LAST_MODIFIED="0" PERSONAL_TOOLBAR_FOLDER="true">Bookmarks bar</H3>
                    <DL><p>
                        <DT><A HREF="https://news.example/" ADD_DATE="1" ICON="data:image/png;base64,iVBORw0KGgo=">News</A>
                        <DT><H3>Deep</H3>
                        <DL><p>
                            <DT><A HREF="https://deep.example/a?b=1&amp;c=2">Deep &lt;one&gt; &#38; &#x263A;</A>
                        </DL><p>
                    </DL><p>
                    <DT><A HREF="https://top.example/">  Top
                        link  </A>
                </DL><p>
                """);
        assertThat(parsed.nodes()).containsExactly(
                folder(-1, "Bookmarks bar"),
                link(0, "News", "https://news.example/"),
                folder(0, "Deep"),
                link(2, "Deep <one> & \u263a", "https://deep.example/a?b=1&c=2"),
                link(-1, "Top link", "https://top.example/"));
        assertThat(parsed.links()).isEqualTo(3);
        assertThat(parsed.refused()).isZero();
    }

    @Test
    void onlyHttpAndHttpsLinksAreKept() throws Exception {
        BookmarksHtml.Parsed parsed = parse("""
                <DL><p>
                    <DT><A HREF="javascript:alert(document.cookie)">Bookmarklet</A>
                    <DT><A HREF="place:sort=8&maxResults=10">Most visited</A>
                    <DT><A HREF="file:///etc/passwd">A file</A>
                    <DT><A>No address</A>
                    <DT><A HREF='http://single.example/'>Single quotes</A>
                    <DT><A HREF=https://bare.example/>Bare</A>
                </DL>
                """);
        assertThat(parsed.nodes()).containsExactly(
                link(-1, "Single quotes", "http://single.example/"), link(-1, "Bare", "https://bare.example/"));
        assertThat(parsed.refused()).isEqualTo(4);
    }

    @Test
    void aLinkWithNoTitleIsNamedByItsAddressAndAFolderWithNoneIsAFolder() throws Exception {
        BookmarksHtml.Parsed parsed = parse("<DL><DT><H3></H3><DL><DT><A HREF=\"https://x.example/\"></A></DL></DL>");
        assertThat(parsed.nodes()).containsExactly(folder(-1, "Folder"), link(0, "https://x.example/", "https://x.example/"));
    }

    @Test
    void aFolderWithNoListDoesntTakeTheNextOne() throws Exception {
        BookmarksHtml.Parsed parsed = parse("""
                <DL>
                    <DT><H3>Empty</H3>
                    <DT><A HREF="https://a.example/">A</A>
                    <DT><H3>Full</H3>
                    <DL><DT><A HREF="https://b.example/">B</A></DL>
                </DL>
                """);
        assertThat(parsed.nodes()).containsExactly(
                folder(-1, "Empty"), link(-1, "A", "https://a.example/"), folder(-1, "Full"), link(2, "B", "https://b.example/"));
    }

    @Test
    void foldersPastTheDepthKeepTheirLinksInTheDeepestOneKept() throws Exception {
        StringBuilder html = new StringBuilder("<DL>");
        int depth = BookmarksHtml.MAX_DEPTH + 5;
        for (int i = 0; i < depth; i++) {
            html.append("<DT><H3>F").append(i).append("</H3><DL>");
        }
        html.append("<DT><A HREF=\"https://deep.example/\">Deep</A>");
        html.append("</DL>".repeat(depth)).append("</DL>");
        BookmarksHtml.Parsed parsed = parse(html.toString());
        BookmarksHtml.Node deep = parsed.nodes().get(parsed.nodes().size() - 1);
        assertThat(deep.url()).isEqualTo("https://deep.example/");
        int levels = 0;
        for (int up = deep.parent(); up >= 0; up = parsed.nodes().get(up).parent()) {
            levels++;
        }
        assertThat(levels).isLessThanOrEqualTo(BookmarksHtml.MAX_DEPTH);
    }

    @Test
    void titlesAreCleanedAndCut() throws Exception {
        String longTitle = "t".repeat(BookmarksHtml.TITLE_CHARS + 50);
        BookmarksHtml.Parsed parsed = parse("<DL><DT><A HREF=\"https://a.example/\">Ev\u202eil " + longTitle + "</A></DL>");
        assertThat(parsed.nodes().get(0).title()).startsWith("Evil ").hasSize(BookmarksHtml.TITLE_CHARS);
    }

    @Test
    void whatIsntABookmarksFileSaysFormat() {
        for (String notOne : List.of("", "hello", "url,password\nhttps://a.example/,x\n")) {
            assertThatThrownBy(() -> parse(notOne))
                    .isInstanceOfSatisfying(RpcException.class, e -> {
                        assertThat(e.code()).isEqualTo(RpcException.BAD_REQUEST);
                        assertThat(e.details()).isEqualTo(Map.of("reason", "format"));
                    });
        }
    }

    @Test
    void moreThanTheLimitIsTooLarge() {
        StringBuilder html = new StringBuilder("<DL>");
        for (int i = 0; i <= BookmarksHtml.MAX_NODES; i++) {
            html.append("<DT><A HREF=\"https://s").append(i).append(".example/\">x</A>");
        }
        assertThatThrownBy(() -> parse(html.toString()))
                .isInstanceOfSatisfying(RpcException.class, e -> {
                    assertThat(e.code()).isEqualTo(RpcException.TOO_LARGE);
                    assertThat(e.details()).isEqualTo(Map.of("limit", BookmarksHtml.MAX_NODES, "reason", "bookmarks"));
                });
    }

    @Test
    void anUnclosedTagOrHugeAttributeEndsCleanly() throws Exception {
        assertThat(parse("<DL><DT><A HREF=\"https://a.example/\" ICON=\"" + "A".repeat(200_000) + "\">A</A></DL>").nodes())
                .containsExactly(link(-1, "A", "https://a.example/"));
        assertThat(parse("<DL><DT><A HREF=\"https://a.example/").nodes()).isEmpty();
        assertThat(parse("<DL><DT><H3>Never closed").nodes()).containsExactly(folder(-1, "Never closed"));
    }
}
