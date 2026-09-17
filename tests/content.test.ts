import { describe, it, expect } from "vitest";
import { buildPayload } from "../src/lib/qr/content";

describe("buildPayload", () => {
  describe("url", () => {
    it("returns a fully-qualified URL as-is", () => {
      expect(buildPayload("url", { url: "https://getsqanny.com" })).toBe(
        "https://getsqanny.com"
      );
    });

    it("prepends https:// when no protocol is present", () => {
      expect(buildPayload("url", { url: "getsqanny.com" })).toBe(
        "https://getsqanny.com"
      );
    });

    it("preserves http:// protocol", () => {
      expect(buildPayload("url", { url: "http://example.com" })).toBe(
        "http://example.com"
      );
    });

    it("trims surrounding whitespace before protocol detection", () => {
      expect(buildPayload("url", { url: "  example.com  " })).toBe(
        "https://example.com"
      );
    });

    it("throws when url field missing", () => {
      expect(() => buildPayload("url", {})).toThrow();
    });
  });

  describe("text", () => {
    it("returns raw text unchanged", () => {
      expect(buildPayload("text", { text: "Hello, World! 日本" })).toBe(
        "Hello, World! 日本"
      );
    });

    it("throws when text field missing", () => {
      expect(() => buildPayload("text", {})).toThrow();
    });
  });

  describe("wifi", () => {
    it("emits canonical WIFI string", () => {
      expect(
        buildPayload("wifi", {
          ssid: "MyNet",
          password: "secret",
          auth: "WPA",
          hidden: "false",
        })
      ).toBe("WIFI:T:WPA;S:MyNet;P:secret;H:false;;");
    });

    it("escapes special chars in ssid and password", () => {
      // backslash, semicolon, comma, colon, doublequote must be escaped with \
      const out = buildPayload("wifi", {
        ssid: 'a;b,c:d"e\\f',
        password: 'p;q,r:s"t\\u',
        auth: "WPA",
      });
      expect(out).toBe(
        'WIFI:T:WPA;S:a\\;b\\,c\\:d\\"e\\\\f;P:p\\;q\\,r\\:s\\"t\\\\u;H:false;;'
      );
    });

    it("defaults auth to WPA and hidden to false", () => {
      expect(buildPayload("wifi", { ssid: "Net", password: "pw" })).toBe(
        "WIFI:T:WPA;S:Net;P:pw;H:false;;"
      );
    });

    it("supports nopass (open) networks", () => {
      expect(
        buildPayload("wifi", { ssid: "Open", auth: "nopass" })
      ).toBe("WIFI:T:nopass;S:Open;P:;H:false;;");
    });

    it("honors hidden=true", () => {
      expect(
        buildPayload("wifi", { ssid: "Net", password: "pw", hidden: "true" })
      ).toBe("WIFI:T:WPA;S:Net;P:pw;H:true;;");
    });

    it("throws when ssid missing", () => {
      expect(() => buildPayload("wifi", { password: "pw" })).toThrow();
    });
  });

  describe("email", () => {
    it("emits mailto with subject and body", () => {
      expect(
        buildPayload("email", {
          email: "a@b.com",
          subject: "Hi there",
          body: "How are you?",
        })
      ).toBe("mailto:a@b.com?subject=Hi%20there&body=How%20are%20you%3F");
    });

    it("emits a bare mailto when no subject/body", () => {
      expect(buildPayload("email", { email: "a@b.com" })).toBe("mailto:a@b.com");
    });

    it("throws when email missing", () => {
      expect(() => buildPayload("email", {})).toThrow();
    });
  });

  describe("tel", () => {
    it("emits a tel URI with the number", () => {
      expect(buildPayload("tel", { phone: "+1 (555) 123-4567" })).toBe(
        "tel:+15551234567"
      );
    });

    it("keeps a leading plus and strips formatting", () => {
      expect(buildPayload("tel", { phone: "+90 532 000 00 00" })).toBe(
        "tel:+905320000000"
      );
    });

    it("throws when phone missing", () => {
      expect(() => buildPayload("tel", {})).toThrow();
    });
  });

  describe("sms", () => {
    it("emits SMSTO with number and message", () => {
      expect(
        buildPayload("sms", { phone: "+15551234567", message: "Hello" })
      ).toBe("SMSTO:+15551234567:Hello");
    });

    it("emits SMSTO without message", () => {
      expect(buildPayload("sms", { phone: "+15551234567" })).toBe(
        "SMSTO:+15551234567:"
      );
    });

    it("throws when phone missing", () => {
      expect(() => buildPayload("sms", { message: "hi" })).toThrow();
    });
  });

  describe("vcard", () => {
    it("emits a valid vCard 3.0 with provided fields", () => {
      const out = buildPayload("vcard", {
        firstName: "Ada",
        lastName: "Lovelace",
        org: "Analytical Engines",
        phone: "+15551234567",
        email: "ada@example.com",
        url: "https://ada.example.com",
      });
      const lines = out.split("\r\n");
      expect(lines[0]).toBe("BEGIN:VCARD");
      expect(lines[1]).toBe("VERSION:3.0");
      expect(out).toContain("FN:Ada Lovelace");
      expect(out).toContain("N:Lovelace;Ada;;;");
      expect(out).toContain("ORG:Analytical Engines");
      expect(out).toContain("TEL:+15551234567");
      expect(out).toContain("EMAIL:ada@example.com");
      expect(out).toContain("URL:https://ada.example.com");
      expect(lines[lines.length - 1]).toBe("END:VCARD");
    });

    it("escapes vCard special characters (comma, semicolon, backslash, newline)", () => {
      const out = buildPayload("vcard", {
        firstName: "A;B",
        lastName: "C,D",
        org: "X;Y,Z\\W",
      });
      expect(out).toContain("FN:A\\;B C\\,D");
      expect(out).toContain("ORG:X\\;Y\\,Z\\\\W");
    });

    it("omits empty optional fields", () => {
      const out = buildPayload("vcard", { firstName: "Solo" });
      expect(out).toContain("FN:Solo");
      expect(out).not.toContain("ORG:");
      expect(out).not.toContain("EMAIL:");
    });

    it("throws when no name fields provided", () => {
      expect(() => buildPayload("vcard", {})).toThrow();
    });
  });

  describe("rich dynamic types", () => {
    for (const type of ["pdf", "menu", "business", "appstore", "social"] as const) {
      it(`returns the resolved url for ${type}`, () => {
        expect(
          buildPayload(type, { url: "https://getsqanny.com/r/abc123" })
        ).toBe("https://getsqanny.com/r/abc123");
      });

      it(`throws for ${type} when no url present`, () => {
        expect(() => buildPayload(type, {})).toThrow();
      });
    }
  });

  it("throws on an unknown type", () => {
    // @ts-expect-error testing runtime guard for unknown type
    expect(() => buildPayload("nope", {})).toThrow();
  });
});
