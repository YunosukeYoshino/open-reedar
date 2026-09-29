import { describe, expect, test } from "bun:test";
import { cleanArticle, decodeBody, feedLinks, parseFeed, plainText } from "../src/main/feeds";
import { isPublicAddress, publicUrl } from "../src/main/network";

describe("feed ingestion", () => {
  test("parses RSS and keeps a stable identity across updates", async () => {
    const xml = `<rss version="2.0"><channel><title>Engineering &amp; Design</title><link>https://example.com</link><item><guid>stable</guid><title>A &amp; B</title><link>https://example.com/a</link><description><![CDATA[<p>Hello <b>world</b></p>]]></description><pubDate>Thu, 10 Sep 2026 10:00:00 GMT</pubDate></item></channel></rss>`;
    const first = await parseFeed(xml, "https://example.com/rss", null);
    const second = await parseFeed(xml.replace("Hello", "Updated"), "https://example.com/rss", null);
    expect(first.feed.title).toBe("Engineering & Design");
    expect(first.articles[0]?.text).toBe("Hello world");
    expect(first.articles[0]?.id).toBe(second.articles[0]?.id);
    expect(first.articles[0]?.publishedAt).toBe("2026-09-10T10:00:00.000Z");
  });

  test("parses Atom and resolves article-relative links and images", async () => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom</title><link href="https://example.com"/><entry><id>urn:one</id><title>One</title><link href="https://example.com/posts/one"/><updated>2026-09-10T00:00:00Z</updated><content type="html">&lt;p&gt;Hi &lt;img src="/cover.jpg"/&gt;&lt;/p&gt;</content></entry></feed>`;
    const result = await parseFeed(xml, "https://example.com/atom", "folder");
    expect(result.feed.folderId).toBe("folder");
    expect(result.articles[0]?.imageUrl).toBe("https://example.com/cover.jpg");
    expect(result.articles[0]?.html).toContain("/image?url=");
  });

  test("strips executable HTML, handlers, styles, unsafe links and forms", () => {
    const result = cleanArticle(`<script>alert(1)</script><style>body{display:none}</style><p onclick="bad()" style="position:fixed">Readable</p><a href="javascript:alert(1)">bad</a><img src="http://127.0.0.1/private" onerror="bad()"><iframe src="https://example.com"></iframe><form><input name="secret"></form><svg onload="bad()"></svg>`, "https://example.com");
    expect(result.html).not.toMatch(/script|style|onclick|onerror|iframe|form|input|svg|127\.0\.0\.1/);
    expect(result.text).toContain("Readable");
    expect(result.imageUrl).toBeNull();
    expect(plainText("<p>A &amp; B</p><p>C</p>")).toBe("A & B\nC");
  });

  test("rejects DTDs and invalid feeds", async () => {
    await expect(parseFeed('<!DOCTYPE rss [<!ENTITY secret SYSTEM "file:///etc/passwd">]><rss/>', "https://example.com/rss", null)).rejects.toThrow("external entities");
    await expect(parseFeed("<html>no feed</html>", "https://example.com/rss", null)).rejects.toThrow();
  });

  test("explains HTML pages are not feeds instead of reporting entities", async () => {
    for (const html of ['<!DOCTYPE html><html><head><title>Site</title></head><body>x</body></html>', '<html lang="ja"><body>site</body></html>', '  \n<!doctype html><html></html>']) {
      await expect(parseFeed(html, "https://example.com/", null)).rejects.toThrow("RSS/Atom");
    }
    await expect(parseFeed('<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body/></html>', "https://example.com/", null)).rejects.toThrow();
  });

  test("decodes feed bodies using the declared charset", () => {
    const header = Buffer.from(`<?xml version="1.0" encoding="Shift_JIS"?><rss version="2.0"><channel><title>`, "ascii");
    const footer = Buffer.from(`</title></channel></rss>`, "ascii");
    const title = Buffer.from([0x83, 0x65, 0x83, 0x58, 0x83, 0x67]); // テスト in Shift_JIS
    expect(decodeBody(Buffer.concat([header, title, footer]), "application/rss+xml")).toContain("<title>テスト</title>");
    expect(decodeBody(Buffer.from('<rss version="2.0"><channel><title>plain</title></channel></rss>'), "text/xml")).toContain("plain");
  });

  test("discovers feed links on an HTML page", () => {
    const html = `<!doctype html><html><head>
      <link rel="alternate" type="application/rss+xml" title="Main feed" href="/feed.xml">
      <link rel="alternate" type="application/atom+xml" href="https://cdn.example.com/atom">
      <link rel="alternate" type="application/rss+xml" href="/feed.xml">
      <link rel="stylesheet" href="/style.css">
      <link rel="alternate" type="application/rss+xml" href="http://127.0.0.1/feed">
      <link rel="alternate" type="text/css" href="/theme.css">
    </head></html>`;
    expect(feedLinks(html, "https://example.com/blog/post")).toEqual([
      { url: "https://example.com/feed.xml", title: "Main feed" },
      { url: "https://cdn.example.com/atom", title: "" },
    ]);
    expect(feedLinks("<html><body>none</body></html>", "https://example.com")).toEqual([]);
  });
});

describe("public network boundary", () => {
  test("rejects local, encoded, credential-bearing and non-HTTP URLs", () => {
    for (const url of ["http://localhost/x", "http://127.1/x", "http://2130706433/x", "http://0x7f000001/x", "http://10.0.0.1", "http://[::1]", "http://[::ffff:127.0.0.1]", "https://user:pass@example.com", "file:///etc/passwd", "http://example.com:3000/x"]) {
      expect(() => publicUrl(url)).toThrow();
    }
    expect(publicUrl("https://example.com/feed#fragment").href).toBe("https://example.com/feed");
  });
  test("rejects private, link-local, multicast and mapped private DNS results", () => {
    for (const ip of ["10.1.2.3", "192.168.0.1", "172.16.0.1", "169.254.169.254", "0.0.0.0", "224.0.0.1", "::1", "fc00::1", "fe80::1", "::ffff:10.0.0.1"]) expect(isPublicAddress(ip)).toBe(false);
    expect(isPublicAddress("1.1.1.1")).toBe(true);
    expect(isPublicAddress("2606:4700:4700::1111")).toBe(true);
  });
});
