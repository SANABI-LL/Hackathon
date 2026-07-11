import { describe, expect, it } from "vitest";
import { htmlToText } from "../kb";

describe("htmlToText", () => {
  it("removes scripts, styles, nav, and footer content", () => {
    const text = htmlToText(`
      <html>
        <head><style>.hidden { color: red; }</style></head>
        <body>
          <nav>Menu link</nav>
          <main>
            <h1>Policy title</h1>
            <p>Submit the form &amp; supporting evidence.</p>
            <script>window.bad = true;</script>
          </main>
          <footer>Footer links</footer>
        </body>
      </html>
    `);

    expect(text).toContain("Policy title");
    expect(text).toContain("Submit the form & supporting evidence.");
    expect(text).not.toContain("Menu link");
    expect(text).not.toContain("Footer links");
    expect(text).not.toContain("window.bad");
  });

  it("normalizes whitespace and line breaks", () => {
    expect(htmlToText("<p>First&nbsp;line</p><p>Second<br>line</p>")).toBe(
      "First line\nSecond\nline"
    );
  });
});
