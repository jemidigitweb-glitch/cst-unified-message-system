import { describe, expect, it } from "vitest";

import type { Attachment } from "@/lib/domain/attachment";
import {
  ATTRIBUTE_COLOUR,
  ATTRIBUTE_DIMENSIONS,
  ATTRIBUTE_WATTAGE,
  type ReportingMessage,
  customerEvidenceImages,
  customerReportedProductDetails,
  imageGapMessage,
  listingAttributesFrom,
} from "@/lib/domain/customer-reported-product-details";

/**
 * Two failures matter here and they are not the same failure.
 *
 *   INVENTION   a listing value, a reported value or an image that nobody
 *               supplied. Tested by asserting nulls and empties as hard as
 *               values.
 *   CONFLATION  a customer's claim presented as the specification, our own
 *               photo presented as their evidence, or a negated claim reduced
 *               to the token it denies. Tested by feeding in data that would
 *               cross the two columns if the wiring were wrong.
 */

function inbound(bodyText: string, attachments: Attachment[] = []): ReportingMessage {
  return { direction: "inbound", bodyText, bodyDecodeStatus: "decoded", attachments };
}

function outbound(bodyText: string, attachments: Attachment[] = []): ReportingMessage {
  return { direction: "outbound", bodyText, bodyDecodeStatus: "decoded", attachments };
}

function image(url: string, label = "photo.jpg"): Attachment {
  return { url, kind: "image", label };
}

function rowFor(
  details: ReturnType<typeof customerReportedProductDetails>,
  attribute: string,
) {
  return details.attributes.find((row) => row.attribute === attribute);
}

describe("dimensions mismatch", () => {
  it("shows the listing dimension against the one the customer measured", () => {
    const details = customerReportedProductDetails({
      listingText: "Ceiling Pendant Lamp Shade 10cm Drop",
      messages: [inbound("The shade that arrived measures 13 cm, not what I ordered")],
    });

    const row = rowFor(details, ATTRIBUTE_DIMENSIONS);
    expect(row?.listingValue).toBe("10cm");
    expect(row?.reportedValue).toContain("13 cm");
  });

  it("leaves the listing column null when the listing text carried no dimension", () => {
    const details = customerReportedProductDetails({
      listingText: "Ceiling Pendant Lamp Shade",
      messages: [inbound("The one I received is 13 cm")],
    });

    const row = rowFor(details, ATTRIBUTE_DIMENSIONS);
    expect(row?.reportedValue).toBe("13 cm");
    // The gap stays a gap. Filling it from the customer's own claim would turn
    // the complaint into the specification it is being compared against.
    expect(row?.listingValue).toBeNull();
  });

  it("keeps the customer's units verbatim rather than converting them", () => {
    const details = customerReportedProductDetails({
      listingText: "Shade 10cm",
      messages: [inbound("It arrived at 130 mm")],
    });

    expect(rowFor(details, ATTRIBUTE_DIMENSIONS)?.reportedValue).toBe("130 mm");
  });

  it("does not truncate a spelled-out unit to a shorter one", () => {
    const details = customerReportedProductDetails({
      listingText: null,
      messages: [inbound("The cable that arrived is 3 metres")],
    });

    expect(rowFor(details, ATTRIBUTE_DIMENSIONS)?.reportedValue).toBe("3 metres");
  });
});

describe("colour mismatch", () => {
  it("shows the listing colour against what the customer says arrived", () => {
    const details = customerReportedProductDetails({
      listingText: "Modern Red Pendant Light",
      messages: [inbound("The lamp I received is orange")],
    });

    const row = rowFor(details, ATTRIBUTE_COLOUR);
    expect(row?.listingValue).toBe("Red");
    expect(row?.reportedValue).toContain("orange");
  });

  it("keeps a negated colour claim as the customer's own sentence", () => {
    const details = customerReportedProductDetails({
      listingText: "Modern Red Pendant Light",
      messages: [inbound("The colour I received does not look like real red")],
    });

    const row = rowFor(details, ATTRIBUTE_COLOUR);
    expect(row?.listingValue).toBe("Red");
    // The whole point: reducing this to `red` would assert agreement with the
    // listing, which is the opposite of what the customer said.
    expect(row?.reportedValue).toBe("The colour I received does not look like real red");
    expect(row?.reportedValue).not.toBe("red");
  });

  it("ignores a colour the customer is asking for rather than reporting", () => {
    const details = customerReportedProductDetails({
      listingText: "Modern Red Pendant Light",
      messages: [inbound("Do you have this in black?")],
    });

    // A pre-sales request is not a discrepancy claim and must not appear as one.
    expect(rowFor(details, ATTRIBUTE_COLOUR)).toBeUndefined();
  });
});

describe("wattage mismatch", () => {
  it("shows the listing wattage against the one the customer reports", () => {
    const details = customerReportedProductDetails({
      listingText: "LED Bulb 12W Warm White",
      messages: [inbound("The bulb that arrived is 20W")],
    });

    const row = rowFor(details, ATTRIBUTE_WATTAGE);
    expect(row?.listingValue).toBe("12W");
    expect(row?.reportedValue).toContain("20W");
  });

  it("does not read a number followed by an unrelated w-word as a wattage", () => {
    const details = customerReportedProductDetails({
      listingText: "LED Bulb 12W",
      messages: [inbound("It arrived 5 weeks late")],
    });

    expect(rowFor(details, ATTRIBUTE_WATTAGE)).toBeUndefined();
  });
});

describe("multiple attributes", () => {
  it("reports every attribute the customer raised, each against its own listing value", () => {
    const details = customerReportedProductDetails({
      listingText: "Red LED Pendant Lamp 12W 10cm Shade",
      messages: [
        inbound("The shade I received measures 13 cm and the bulb is 20W"),
        inbound("Also the colour that arrived is orange"),
      ],
    });

    expect(details.attributes.map((row) => row.attribute)).toEqual([
      ATTRIBUTE_DIMENSIONS,
      ATTRIBUTE_COLOUR,
      ATTRIBUTE_WATTAGE,
    ]);
    expect(rowFor(details, ATTRIBUTE_DIMENSIONS)?.listingValue).toBe("10cm");
    expect(rowFor(details, ATTRIBUTE_COLOUR)?.listingValue).toBe("Red");
    expect(rowFor(details, ATTRIBUTE_WATTAGE)?.listingValue).toBe("12W");
    expect(rowFor(details, ATTRIBUTE_WATTAGE)?.reportedValue).toContain("20W");
  });

  it("adds no row for an attribute the listing has but the customer never mentioned", () => {
    const details = customerReportedProductDetails({
      listingText: "Red LED Pendant Lamp 12W 10cm Shade",
      messages: [inbound("The bulb that arrived is 20W")],
    });

    // The section is what the CUSTOMER reported. Without this rule it fills
    // with catalogue specifications under a heading saying they said them.
    expect(details.attributes.map((row) => row.attribute)).toEqual([ATTRIBUTE_WATTAGE]);
  });

  it("reports nothing at all when the customer raised nothing", () => {
    const details = customerReportedProductDetails({
      listingText: "Red LED Pendant Lamp 12W 10cm Shade",
      messages: [inbound("When will my order be dispatched?")],
    });

    expect(details.attributes).toEqual([]);
  });

  it("never takes a reported value from our own reply", () => {
    const details = customerReportedProductDetails({
      listingText: "LED Bulb 12W",
      messages: [outbound("We have sent you the 20W version as a replacement")],
    });

    expect(details.attributes).toEqual([]);
  });
});

/**
 * The three-source split.
 *
 * The failure this guards is a customer's recollection of what they ordered
 * being shown as, or merged into, the verified listing value — and its mirror,
 * a colour named on the ordered side leaking into the received side and making
 * the two halves of a complaint appear to agree.
 */
describe("customer expected vs received", () => {
  const ORDERED_AND_RECEIVED =
    "I ordered the plain black single plug socket and received a black and chrome one";

  it("separates what the customer ordered from what arrived, in one sentence", () => {
    const details = customerReportedProductDetails({
      listingText: null,
      messages: [inbound(ORDERED_AND_RECEIVED)],
    });

    const row = rowFor(details, ATTRIBUTE_COLOUR);
    expect(row?.expectedValue).toBe("plain black");
    expect(row?.reportedValue).toBe("black and chrome");
  });

  it("keeps the customer's expected value out of the verified column", () => {
    const details = customerReportedProductDetails({
      listingText: null,
      messages: [inbound(ORDERED_AND_RECEIVED)],
    });

    // The listing carried nothing. The column stays empty rather than borrowing
    // the customer's own recollection to fill itself.
    expect(rowFor(details, ATTRIBUTE_COLOUR)?.listingValue).toBeNull();
  });

  it("does not let the ordered colour leak into the received value", () => {
    const row = rowFor(
      customerReportedProductDetails({
        listingText: null,
        messages: [inbound(ORDERED_AND_RECEIVED)],
      }),
      ATTRIBUTE_COLOUR,
    );

    // Before the split, token matching deduplicated both halves to
    // "black, chrome" and the two columns appeared to agree.
    expect(row?.reportedValue).not.toBe(row?.expectedValue);
    expect(row?.reportedValue).not.toContain("plain");
  });

  it("holds all three values at once when the listing also carries the attribute", () => {
    const details = customerReportedProductDetails({
      listingText: "Single Plug Socket Plain Black Screwless Flat Plate",
      messages: [inbound(ORDERED_AND_RECEIVED)],
    });

    const row = rowFor(details, ATTRIBUTE_COLOUR);
    expect(row?.listingValue).toBe("Plain Black");
    expect(row?.expectedValue).toBe("plain black");
    expect(row?.reportedValue).toBe("black and chrome");
  });

  it("keeps a modifier the customer used rather than reducing it to the colour", () => {
    const row = rowFor(
      customerReportedProductDetails({
        listingText: null,
        messages: [inbound("I ordered the matt black one but a gloss white one arrived")],
      }),
      ATTRIBUTE_COLOUR,
    );

    expect(row?.expectedValue).toBe("matt black");
    expect(row?.reportedValue).toBe("gloss white");
  });

  it("reads a value that sits before its cue", () => {
    const row = rowFor(
      customerReportedProductDetails({
        listingText: null,
        messages: [inbound("Should be the green brass version but a light brass one has been sent")],
      }),
      ATTRIBUTE_COLOUR,
    );

    // Single-role clauses are used whole, because the value can sit either side
    // of the cue — here "has been sent" trails the value it describes.
    expect(row?.expectedValue).toBe("green brass");
    expect(row?.reportedValue).toBe("light brass");
  });

  it("captures an expected wattage that was previously discarded", () => {
    const row = rowFor(
      customerReportedProductDetails({
        listingText: "LED Bulb 4W Warm White",
        messages: [inbound("We ordered a 4 watt bulb but we have received an 8 watt")],
      }),
      ATTRIBUTE_WATTAGE,
    );

    expect(row?.listingValue).toBe("4W");
    expect(row?.expectedValue).toBe("4 watt");
    expect(row?.reportedValue).toBe("8 watt");
  });

  it("leaves expected null when the customer only said what arrived", () => {
    const row = rowFor(
      customerReportedProductDetails({
        listingText: "LED Bulb 12W",
        messages: [inbound("The bulb that arrived is 20W")],
      }),
      ATTRIBUTE_WATTAGE,
    );

    expect(row?.expectedValue).toBeNull();
    expect(row?.reportedValue).toBe("20W");
  });

  it("produces no row for an expectation with nothing received", () => {
    const details = customerReportedProductDetails({
      listingText: "Red LED Pendant Lamp",
      messages: [inbound("I wanted the black one")],
    });

    // An expected value alone is a pre-sales request, not a discrepancy, and
    // belongs to customer-product-data.ts.
    expect(details.attributes).toEqual([]);
  });

  it("never takes an expected value from our own reply", () => {
    const details = customerReportedProductDetails({
      listingText: null,
      messages: [outbound("You ordered the plain black one and we sent a black and chrome one")],
    });

    expect(details.attributes).toEqual([]);
  });
});

/**
 * Live regressions, each reproduced from the conversation that exposed it.
 */
describe("live regression — a listing dimension of a different kind", () => {
  const WIRE_LISTING =
    "2 Core Twisted Fabric Cable Vintage Wire Electric Flexible Lighting Cord 0.75mm[Brown]";
  const WIRE_MESSAGE =
    "Received my wire today it's only 130cm long I expected a 5m length in the advert it shows a 5m roll this isn't long enough for the job I'm doing shall I return it";

  it("does not offer a cable gauge as the verified expected length", () => {
    const row = rowFor(
      customerReportedProductDetails({ listingText: WIRE_LISTING, messages: [inbound(WIRE_MESSAGE)] }),
      ATTRIBUTE_DIMENSIONS,
    );

    // 0.75mm is the conductor gauge. Against 130cm it is not a disagreement,
    // and shown here it would read as the length the listing promised.
    expect(row?.listingValue).toBeNull();
    expect(row?.expectedValue).toBe("5m");
    expect(row?.reportedValue).toBe("130cm");
  });

  it("still shows a listing dimension of the same kind", () => {
    const row = rowFor(
      customerReportedProductDetails({
        listingText: "Ceiling Pendant Lamp Shade 10cm Drop",
        messages: [inbound("The shade I received measures 13 cm")],
      }),
      ATTRIBUTE_DIMENSIONS,
    );

    expect(row?.listingValue).toBe("10cm");
  });

  it("keeps only the comparable dimensions when the listing states several", () => {
    const row = rowFor(
      customerReportedProductDetails({
        listingText: "Shade 30 x 40 cm on 0.75mm cord",
        messages: [inbound("The shade I received measures 13 cm")],
      }),
      ATTRIBUTE_DIMENSIONS,
    );

    expect(row?.listingValue).toBe("30 x 40 cm");
  });

  it("keeps the listing dimension when the customer measured nothing", () => {
    const row = rowFor(
      customerReportedProductDetails({
        listingText: "Ceiling Pendant Lamp Shade 10cm Drop",
        messages: [inbound("The shade that arrived is too small")],
      }),
      ATTRIBUTE_DIMENSIONS,
    );

    // Nothing to be incomparable with is not a mismatch.
    expect(row === undefined || row.listingValue === "10cm").toBe(true);
  });
});

describe("live regression — a colour outside the fixed vocabulary", () => {
  const BURGUNDY =
    "I ordered the burgundy colour but it was not burgundy to me it was more a dark mauve";

  it("reads a described colour the closed list does not know", () => {
    const row = rowFor(
      customerReportedProductDetails({ listingText: null, messages: [inbound(BURGUNDY)] }),
      ATTRIBUTE_COLOUR,
    );

    expect(row?.expectedValue).toBe("burgundy");
    expect(row?.reportedValue).toBe("dark mauve");
  });

  it("reports the colour the customer asserts, not the one they deny", () => {
    const row = rowFor(
      customerReportedProductDetails({ listingText: null, messages: [inbound(BURGUNDY)] }),
      ATTRIBUTE_COLOUR,
    );

    // "not burgundy" is denied; "more a dark mauve" is asserted. Reporting the
    // denied value would state the opposite of the complaint.
    expect(row?.reportedValue).not.toContain("burgundy");
  });

  it("does not weaken the negation fallback when every value is denied", () => {
    const row = rowFor(
      customerReportedProductDetails({
        listingText: "Modern Red Pendant Light",
        messages: [inbound("The colour I received does not look like real red")],
      }),
      ATTRIBUTE_COLOUR,
    );

    expect(row?.reportedValue).toBe("The colour I received does not look like real red");
  });

  it("does not read a non-colour word out of a colour construction", () => {
    for (const message of [
      "The one I received is the wrong colour",
      "The colour I received is not what I expected",
    ]) {
      const row = rowFor(
        customerReportedProductDetails({ listingText: null, messages: [inbound(message)] }),
        ATTRIBUTE_COLOUR,
      );
      for (const bad of ["wrong", "not", "what"]) {
        expect(row?.reportedValue ?? "").not.toBe(bad);
        expect(row?.expectedValue ?? "").not.toBe(bad);
      }
    }
  });

  it("leaves a known colour read exactly as before", () => {
    const row = rowFor(
      customerReportedProductDetails({
        listingText: "Modern Red Pendant Light",
        messages: [inbound("The lamp I received is orange")],
      }),
      ATTRIBUTE_COLOUR,
    );

    expect(row?.listingValue).toBe("Red");
    expect(row?.reportedValue).toBe("orange");
  });
});

describe("live regression — image availability wording", () => {
  const REPORTED = [inbound("The bulb that arrived is 20W")];

  it("says attachments are not captured on eBay, not that none were sent", () => {
    const details = customerReportedProductDetails({
      listingText: "LED Bulb 12W",
      messages: REPORTED,
      marketplace: "ebay",
    });

    expect(details.imageGap).toBe("not_captured");

    const message = imageGapMessage(details.imageGap!, "eBay");
    // The claim a reviewer must not be given: that the customer sent nothing.
    // On eBay they demonstrably do — the images never reach this database.
    expect(message).not.toMatch(/No customer-uploaded images/i);
    expect(message).toContain("eBay");
    expect(message).toMatch(/not captured/i);
  });

  it.each(["shopify", "bandq", "temu"])(
    "keeps the true empty state for %s, where attachments are ingested",
    (marketplace) => {
      const details = customerReportedProductDetails({
        listingText: "LED Bulb 12W",
        messages: REPORTED,
        marketplace,
      });

      expect(details.imageGap).toBe("none_sent");
      expect(imageGapMessage(details.imageGap!, marketplace)).toBe(
        "No customer-uploaded images on this conversation.",
      );
    },
  );

  it("reports no gap at all when the customer did attach an image", () => {
    const photo = image("https://storage.example.com/uploads/damage.jpg");
    const details = customerReportedProductDetails({
      listingText: "LED Bulb 12W",
      messages: [inbound("The bulb that arrived is 20W", [photo])],
      marketplace: "shopify",
    });

    expect(details.imageGap).toBeNull();
    expect(details.images).toEqual([photo]);
  });

  it("claims no gap when there was no inbound message to carry one", () => {
    const details = customerReportedProductDetails({
      listingText: "LED Bulb 12W",
      messages: [outbound("Thanks for getting in touch")],
      marketplace: "ebay",
    });

    expect(details.imageGap).toBeNull();
  });
});

describe("listing extraction is authoritative-data-only", () => {
  it("reads attributes out of listing text", () => {
    const listing = listingAttributesFrom("Red LED Pendant Lamp 12W 10cm Shade");

    expect(listing.get(ATTRIBUTE_COLOUR)).toBe("Red");
    expect(listing.get(ATTRIBUTE_WATTAGE)).toBe("12W");
    expect(listing.get(ATTRIBUTE_DIMENSIONS)).toBe("10cm");
  });

  it("returns nothing for an absent listing rather than a placeholder", () => {
    expect(listingAttributesFrom(null).size).toBe(0);
    expect(listingAttributesFrom("   ").size).toBe(0);
  });

  it("keeps every distinct dimension rather than picking one", () => {
    expect(listingAttributesFrom("Shade 30 x 40 cm with 15 cm fitting").get(ATTRIBUTE_DIMENSIONS))
      .toBe("30 x 40 cm, 15 cm");
  });
});

describe("customer images", () => {
  it("displays a genuine customer-uploaded image", () => {
    const photo = image("https://storage.example.com/uploads/1786616676_6a7d9b640eb7e_damage.jpg");
    const details = customerReportedProductDetails({
      listingText: "Red LED Pendant Lamp 12W",
      messages: [inbound("The bulb that arrived is 20W, photo attached", [photo])],
    });

    expect(details.images).toEqual([photo]);
    expect(details.imageGap).toBeNull();
  });

  it("never shows our own outbound attachment as customer evidence", () => {
    const ourPhoto = image("https://storage.example.com/cst/replacement-we-sent.jpg");
    const images = customerEvidenceImages([
      inbound("It arrived damaged"),
      outbound("Here is the replacement we are sending", [ourPhoto]),
    ]);

    // An outbound photo is ours. Shown under "customer uploaded" it would be
    // our own picture handed back to us as proof of their complaint.
    expect(images).toEqual([]);
  });

  it("never shows a listing or return image, because neither can reach it", () => {
    const details = customerReportedProductDetails({
      listingText: "Red LED Pendant Lamp 12W 10cm Shade",
      messages: [inbound("The colour that arrived is orange")],
    });

    // The listing text is rich enough to render a product shot from, and the
    // conversation resolved to a real order with listing and return photos
    // available elsewhere. None of them are here: the only image input this
    // function has is the conversation's own inbound attachments.
    expect(details.images).toEqual([]);
    expect(details.imageGap).toBe("none_sent");
  });

  it("does not render a PDF invoice as an image", () => {
    const invoice: Attachment = {
      url: "https://storage.example.com/uploads/Invoice_4054211.pdf",
      kind: "document",
      label: "Invoice_4054211.pdf",
    };

    expect(customerEvidenceImages([inbound("Invoice attached", [invoice])])).toEqual([]);
  });

  it("reports the gap rather than showing nothing, when the customer sent no photo", () => {
    const details = customerReportedProductDetails({
      listingText: "LED Bulb 12W",
      messages: [inbound("The bulb that arrived is 20W")],
    });

    expect(details.images).toEqual([]);
    expect(details.imageGap).toBe("none_sent");
  });

  it("does not claim a gap when there is no inbound message to have sent one", () => {
    const details = customerReportedProductDetails({
      listingText: "LED Bulb 12W",
      messages: [outbound("Thanks for getting in touch")],
    });

    // "The customer sent no photograph" and "there is nothing here to look at"
    // are different statements, and only the first is safe to act on.
    expect(details.imageGap).toBeNull();
  });

  it("shows one image once when the same photo arrives on two messages", () => {
    const photo = image("https://storage.example.com/uploads/damage.jpg");
    expect(customerEvidenceImages([inbound("See photo", [photo]), inbound("Again", [photo])]))
      .toEqual([photo]);
  });
});

/* ========================================================================= *
 * AUG 27 – SEP 1 2026 eBay AUDIT
 *
 * Seven live conversations whose extracted details were wrong, and the three
 * that were right and must stay right. The general rule they encode: a value
 * is only Customer Reported / Received when the customer explicitly states the
 * attribute of the product that arrived.
 * ========================================================================= */

describe("audit — a value must be predicated of what arrived", () => {
  const none = (messages: string[], listingText: string | null = null) =>
    customerReportedProductDetails({
      listingText,
      marketplace: "ebay",
      messages: messages.map((t) => inbound(t)),
    }).attributes;

  it("does not read a colour that describes a part", () => {
    // "this black ring has holes in to accommodate brass screws" — components.
    expect(
      none([
        "here are the photos now as requested. As you can see picture 1 shows wire not able to come through enough to attach earth to, picture 5, this item is for another type of light you are selling, this black ring has holes in to accommodate brass screws.",
      ]),
    ).toEqual([]);
    expect(none(["its tge brass screw connector that has broken at the bulbholder"])).toEqual([]);
    expect(
      none(
        ["Hello, We have started to fix the light and have come to realise that the screws sent for the clear parts are too small."],
        "Gold",
      ),
    ).toEqual([]);
  });

  it("does not read a colour out of missing-part wording", () => {
    expect(
      none(
        ["Good afternoon, I've just received my lampshades, however there was only one white plastic bit. Would you be able to send out another plastic bit please"],
        "Brushed Silver",
      ),
    ).toEqual([]);
  });

  it("does not read values out of a question", () => {
    // Interrogative construction, no question mark anywhere in the message.
    expect(
      none([
        "Hi power adaptor came early looks great I don,t understand the 2 x output wires there,s no paperwork with the item are they 100w per wire ,do I need to double them up to get 200w if there is some sort of technical manual online pls advise many thanks",
      ]),
    ).toEqual([]);
  });

  it("does not read a colour the customer says is wrong without naming what came", () => {
    expect(
      none(
        ["Hi. Lamp arrived not quite the right colour i was exoecting a deeper red/copper colour here is ine i bought from you last time, i need this colour"],
        "Brushed Copper",
      ),
    ).toEqual([]);
  });

  it("does not read a desired replacement as what arrived", () => {
    const rows = customerReportedProductDetails({
      listingText: null,
      marketplace: "ebay",
      messages: [
        inbound("Hia order arrived but the cable is wider than advertised ! Your cables are advertised at 6mm but mine is 8.85mm has there been a mistake I am wanting to hang three celling lights and was hoping it was 6mm wide, does the width change because it's hemp."),
        inbound("Can you please send me the light gold if its 5mm and 5m in length as my order and then no need to refund me hopefully that's okay."),
      ],
    }).attributes;

    // The advertised width is what was expected; the measured one is what came.
    expect(rows.map((r) => r.attribute)).toEqual([ATTRIBUTE_DIMENSIONS]);
    expect(rows[0]?.expectedValue).toBe("6mm");
    expect(rows[0]?.reportedValue).toBe("8.85mm");
  });

  it("does not split a decimal across two clauses", () => {
    const row = customerReportedProductDetails({
      listingText: null,
      marketplace: "ebay",
      messages: [inbound("mine is 8.85mm")],
    }).attributes[0];

    expect(row?.reportedValue).toBe("8.85mm");
  });
});

describe("audit — the correct extractions stay correct", () => {
  it("keeps burgundy against dark mauve", () => {
    const row = customerReportedProductDetails({
      listingText: null,
      marketplace: "ebay",
      messages: [inbound("I ordered the burgundy colour but it was not burgundy to me it was more a dark mauve. I did not take any pictures as I returned it to you straight away.")],
    }).attributes[0];

    expect(row?.expectedValue).toBe("burgundy");
    expect(row?.reportedValue).toBe("dark mauve");
  });

  it("keeps plain black against black and chrome", () => {
    const row = customerReportedProductDetails({
      listingText: null,
      marketplace: "ebay",
      messages: [inbound("Hi I ordered the plain black single plug socket and I have received a black and chrome one?")],
    }).attributes[0];

    expect(row?.expectedValue).toBe("plain black");
    expect(row?.reportedValue).toBe("black and chrome");
  });

  it("keeps blue against green and blue", () => {
    const row = customerReportedProductDetails({
      listingText: "Dark Blue",
      marketplace: "ebay",
      messages: [
        inbound("I ordered 2 dep blue lampshades ,why have you sent me one green and one blue"),
        inbound("Ordered 2 blue shades ,you have sent ,me one blue and one green"),
      ],
    }).attributes[0];

    expect(row?.listingValue).toBe("Dark Blue");
    expect(row?.expectedValue).toBe("blue");
    expect(row?.reportedValue).toBe("green, blue");
  });
});

describe("audit — a contrast the complaint preamble was hiding", () => {
  /**
   * Live 94421, in full. The message opens "Unfortunately ITS the wrong
   * colour", and `its` is a received cue sitting ahead of the expected cue
   * `should be`. Dividing on cue position put the complaint on the received
   * side and both values on the expected side, so the row disappeared —
   * visible only on the whole message, not on the sentence that follows it.
   */
  it("reads green brass against light brass through the preamble", () => {
    const row = customerReportedProductDetails({
      listingText: "Vintage Ceiling Rose Choose Colour[Green Brass + Hook]",
      marketplace: "ebay",
      messages: [
        inbound(
          "Unfortunately its the wrong colour - should be the green brass version but a light brass one has been sent",
        ),
      ],
    }).attributes[0];

    expect(row?.listingValue).toBe("Green Brass");
    expect(row?.expectedValue).toBe("green brass");
    expect(row?.reportedValue).toBe("light brass");
  });

  it("reads a plain ordered-versus-received colour swap", () => {
    const row = customerReportedProductDetails({
      listingText: "Matt Black Wall Light",
      marketplace: "ebay",
      messages: [inbound("I ordered the black one but received a silver one")],
    }).attributes[0];

    expect(row?.listingValue).toBe("Matt Black");
    expect(row?.expectedValue).toBe("black");
    expect(row?.reportedValue).toBe("silver");
  });

  it("keeps the customer's own casing on both sides", () => {
    const row = customerReportedProductDetails({
      listingText: null,
      marketplace: "ebay",
      messages: [inbound("I ordered the Black one but received a Silver one")],
    }).attributes[0];

    expect(row?.expectedValue).toBe("Black");
    expect(row?.reportedValue).toBe("Silver");
  });
});
