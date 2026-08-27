import { describe, expect, it } from "vitest";

import {
  LABEL_ALTERNATIVE,
  LABEL_COLOUR,
  LABEL_COMPATIBILITY,
  LABEL_FINISH,
  LABEL_MEASUREMENT,
  LABEL_REQUIREMENT,
  type CustomerMessage,
  customerProductDataBlock,
  extractCustomerProductData,
  panelCustomerProductData,
} from "@/lib/domain/customer-product-data";

/**
 * The failure that matters here is invention: a row under "Customer product
 * data" that the customer never said. So this tests what it refuses at least
 * as hard as what it finds, and every value it does report has to be findable
 * verbatim in the message it came from.
 */

function inbound(bodyText: string | null, bodyDecodeStatus = "decoded"): CustomerMessage {
  return { direction: "inbound", bodyText, bodyDecodeStatus };
}

function outbound(bodyText: string): CustomerMessage {
  return { direction: "outbound", bodyText, bodyDecodeStatus: "decoded" };
}

function valuesFor(messages: CustomerMessage[], label: string): string[] {
  return extractCustomerProductData(messages)
    .filter((detail) => detail.label === label)
    .map((detail) => detail.value);
}

describe("colour", () => {
  it("picks up a colour the customer asked for", () => {
    expect(valuesFor([inbound("Can I get this in black?")], LABEL_COLOUR)).toEqual(["black"]);
    expect(valuesFor([inbound("Do you have this in white?")], LABEL_COLOUR)).toEqual(["white"]);
  });

  it("picks up a colour named directly", () => {
    expect(valuesFor([inbound("The colour is grey, is that right?")], LABEL_COLOUR)).toEqual(["grey"]);
    expect(valuesFor([inbound("I'd like the brass one please")], LABEL_COLOUR)).toEqual(["brass"]);
  });

  it("keeps the customer's own casing rather than tidying it", () => {
    expect(valuesFor([inbound("Have you got it in Black?")], LABEL_COLOUR)).toEqual(["Black"]);
  });

  /**
   * The reason the colour list is closed. An "any word after `in`" rule would
   * report stock levels and delivery updates as colours.
   */
  it("does not treat every word after 'in' as a colour", () => {
    for (const text of ["Is it back in stock?", "It arrived in the post", "Get in touch please"]) {
      expect(extractCustomerProductData([inbound(text)]), text).toEqual([]);
    }
  });

  it("reports a repeated colour once", () => {
    const messages = [inbound("in black please"), inbound("still want it in black")];
    expect(valuesFor(messages, LABEL_COLOUR)).toEqual(["black"]);
  });
});

describe("measurement", () => {
  it("picks up a size the customer gave", () => {
    expect(valuesFor([inbound("Need a 40cm shade")], LABEL_MEASUREMENT)).toEqual(["40cm"]);
    expect(valuesFor([inbound("I need a shade around 25 cm")], LABEL_MEASUREMENT)).toEqual(["25 cm"]);
  });

  it("picks up several measurements from one message", () => {
    expect(valuesFor([inbound("It needs to be 30cm wide and 45cm tall")], LABEL_MEASUREMENT)).toEqual([
      "30cm",
      "45cm",
    ]);
  });

  it("keeps a dimension pair together", () => {
    expect(valuesFor([inbound("Looking for 30 x 40 cm")], LABEL_MEASUREMENT)).toEqual(["30 x 40 cm"]);
  });

  it("handles imperial units", () => {
    expect(valuesFor([inbound("about 12 inches across")], LABEL_MEASUREMENT)).toEqual(["12 inches"]);
  });

  /**
   * `in` as a unit is indistinguishable from the preposition, so it is not a
   * unit here — otherwise "in black" becomes a measurement.
   */
  it("never reads the preposition 'in' as inches", () => {
    expect(valuesFor([inbound("I ordered 2 in black")], LABEL_MEASUREMENT)).toEqual([]);
  });

  it("ignores numbers with no unit", () => {
    expect(valuesFor([inbound("I ordered 2 of them on the 14th")], LABEL_MEASUREMENT)).toEqual([]);
  });
});

describe("finish", () => {
  it("picks up a finish the customer named", () => {
    expect(valuesFor([inbound("Is it available in a matt finish?")], LABEL_FINISH)).toEqual(["matt"]);
    expect(valuesFor([inbound("finish: brushed")], LABEL_FINISH)).toEqual(["brushed"]);
  });

  it("reports both the finish and the colour when the customer gave both", () => {
    const details = extractCustomerProductData([inbound("Do you do it in matt black?")]);
    expect(details).toContainEqual({ label: LABEL_COLOUR, value: "black" });
    expect(details).toContainEqual({ label: LABEL_FINISH, value: "matt" });
  });
});

describe("requirement", () => {
  it("captures a stated requirement that is about the product", () => {
    expect(
      valuesFor([inbound("It needs a replacement with the correct size.")], LABEL_REQUIREMENT),
    ).toEqual(["It needs a replacement with the correct size"]);
  });

  /**
   * The gate that keeps this section about the product. Without it, every
   * refund and cancellation request would arrive as "product data".
   */
  it("ignores a requirement with nothing product-related in it", () => {
    for (const text of [
      "I need a refund please",
      "I want to cancel this order",
      "I am looking for an update on delivery",
    ]) {
      expect(valuesFor([inbound(text)], LABEL_REQUIREMENT), text).toEqual([]);
    }
  });

  it("truncates a very long clause rather than copying the whole message", () => {
    const long = `I need a ${"very ".repeat(60)}large 30cm shade`;
    const [value] = valuesFor([inbound(long)], LABEL_REQUIREMENT);
    expect(value!.length).toBeLessThanOrEqual(120);
    expect(value!.endsWith("…")).toBe(true);
  });
});

describe("compatibility", () => {
  it("captures a stated compatibility question", () => {
    expect(valuesFor([inbound("Will it fit my existing bracket?")], LABEL_COMPATIBILITY)).toEqual([
      "Will it fit my existing bracket",
    ]);
    expect(
      valuesFor([inbound("Is this compatible with a dimmer switch?")], LABEL_COMPATIBILITY),
    ).toEqual(["Is this compatible with a dimmer switch"]);
  });

  /**
   * The example the brief calls out: never assert suitability the customer did
   * not state.
   */
  it("reports suitability only where the customer raised it", () => {
    expect(valuesFor([inbound("Is this suitable for a kitchen?")], LABEL_COMPATIBILITY)).toEqual([
      "Is this suitable for a kitchen",
    ]);
    expect(valuesFor([inbound("Arrived today, thanks")], LABEL_COMPATIBILITY)).toEqual([]);
  });
});

describe("only the customer speaks here", () => {
  /**
   * A CST reply routinely names a colour or a size. Extracting it would report
   * our own words back as the customer's requirement.
   */
  it("ignores everything in an outbound reply", () => {
    const messages = [
      outbound("We have that in black, and it is 40cm wide."),
      outbound("It is compatible with a dimmer switch."),
    ];
    expect(extractCustomerProductData(messages)).toEqual([]);
  });

  it("reads the customer's message even when a reply also mentions a colour", () => {
    const messages = [
      inbound("Can I get this in white?"),
      outbound("Yes, we stock it in black too."),
    ];
    expect(valuesFor(messages, LABEL_COLOUR)).toEqual(["white"]);
  });

  it("ignores a body that could not be decoded, or is missing or blank", () => {
    expect(extractCustomerProductData([inbound("in black", "undecodable")])).toEqual([]);
    expect(extractCustomerProductData([inbound(null)])).toEqual([]);
    expect(extractCustomerProductData([inbound("   ")])).toEqual([]);
  });
});

describe("saying nothing when the customer said nothing", () => {
  it("returns an empty list for an ordinary message", () => {
    expect(extractCustomerProductData([inbound("Hi, any update on my order please?")])).toEqual([]);
  });

  it("returns an empty list for an empty thread", () => {
    expect(extractCustomerProductData([])).toEqual([]);
  });

  /**
   * Nothing is derived from a catalogue, an order or a SKU — this function is
   * given messages and nothing else, so it cannot be.
   */
  it("invents no attribute the customer did not state", () => {
    const details = extractCustomerProductData([inbound("Can I get this in black?")]);
    expect(details).toEqual([{ label: LABEL_COLOUR, value: "black" }]);
  });
});

describe("the prompt block", () => {
  it("is omitted entirely when the customer stated nothing", () => {
    expect(customerProductDataBlock([])).toBeNull();
  });

  it("labels the data as the customer's and not as verified", () => {
    const block = customerProductDataBlock([{ label: LABEL_COLOUR, value: "black" }]);

    expect(block).toContain("CUSTOMER PRODUCT DATA");
    expect(block).toContain("NOT verified");
    expect(block).toContain("- Requested colour: black");
    // It must not present itself as another verified block.
    expect(block).not.toContain("VERIFIED CONTEXT");
  });

  it("tells the model it cannot override the order context or promise anything", () => {
    const block = customerProductDataBlock([{ label: LABEL_MEASUREMENT, value: "40cm" }])!;

    expect(block).toMatch(/never override the verified order context/i);
    expect(block).toMatch(/never become a promise/i);
    expect(block).toMatch(/ask — do not resolve it by guessing/i);
  });
});

/**
 * A colour the customer POINTED AT is not one they asked for.
 *
 * The conversation that exposed this: a request in one message, and in the
 * next a different listing the customer had come across plus a question about
 * it. Both messages name a real colour; only one of them is a preference.
 */
describe("a referenced alternative is not a request", () => {
  const reportedConversation = [
    inbound("Do you do this in white"),
    inbound(
      "Found one in Chrome in sellers other items that would be suitable, can it work with my corded pull",
    ),
  ];

  it("captures the requested colour", () => {
    expect(valuesFor(reportedConversation, LABEL_COLOUR)).toEqual(["white"]);
  });

  it("does not store the alternative's colour as a requested preference", () => {
    const colours = valuesFor(reportedConversation, LABEL_COLOUR);
    expect(colours).not.toContain("Chrome");
    expect(colours).not.toContain("chrome");
  });

  it("still captures the compatibility question asked about that alternative", () => {
    expect(valuesFor(reportedConversation, LABEL_COMPATIBILITY)).toEqual([
      "can it work with my corded pull",
    ]);
  });

  /**
   * Chrome is shown, but as what it is. Dropping it entirely would leave a
   * reviewer on "Requested colour: white" from the earlier message with no
   * sign the customer had since raised chrome.
   */
  it("keeps the alternative visible under its own label", () => {
    expect(valuesFor(reportedConversation, LABEL_ALTERNATIVE)).toEqual(["Chrome"]);
  });

  it("invents no product fact from either message", () => {
    // Three rows, each traceable to the customer's own words: what they asked
    // for, what they raised, and what they asked about it. Nothing about
    // stock, suitability, the seller's catalogue, or what Chrome fits.
    expect(extractCustomerProductData(reportedConversation)).toEqual([
      { label: LABEL_COLOUR, value: "white" },
      { label: LABEL_ALTERNATIVE, value: "Chrome" },
      { label: LABEL_COMPATIBILITY, value: "can it work with my corded pull" },
    ]);
  });

  it("never files an attribute the customer merely described as a request", () => {
    for (const [text, value] of [
      ["I saw one in black on another listing", "black"],
      ["There is a 40cm version in your other items", "40cm"],
      ["I noticed a brushed finish elsewhere", "brushed"],
      ["Came across one in chrome", "chrome"],
    ] as const) {
      const details = extractCustomerProductData([inbound(text)]);
      const requested = details.filter((detail) =>
        [LABEL_COLOUR, LABEL_MEASUREMENT, LABEL_FINISH, LABEL_REQUIREMENT].includes(detail.label),
      );

      expect(requested, text).toEqual([]);
      expect(details, text).toContainEqual({ label: LABEL_ALTERNATIVE, value });
    }
  });

  /**
   * The gate is per sub-clause, so one half of a sentence describing something
   * cannot suppress a real request in the other half.
   */
  it("still reads a request that shares a sentence with a reference", () => {
    const details = extractCustomerProductData([
      inbound("I found the tracking number, but I need it in white"),
    ]);
    expect(details).toContainEqual({ label: LABEL_COLOUR, value: "white" });
  });
});

/**
 * The sidebar and the prompt want different things. A compatibility question
 * is a whole sentence the reviewer can already read a few inches away in the
 * thread; the draft cannot, and needs it.
 */
describe("what the sidebar shows", () => {
  const details = extractCustomerProductData([
    inbound("Do you do this in white"),
    inbound("Found one in Chrome in sellers other items, can it work with my corded pull"),
  ]);

  it("hides the compatibility question", () => {
    expect(panelCustomerProductData(details).map((detail) => detail.label)).not.toContain(
      LABEL_COMPATIBILITY,
    );
  });

  it("still shows the requested colour and the mentioned alternative", () => {
    expect(panelCustomerProductData(details)).toEqual([
      { label: LABEL_COLOUR, value: "white" },
      { label: LABEL_ALTERNATIVE, value: "Chrome" },
    ]);
  });

  /**
   * Hidden from the panel only. Removing it from the extractor would take it
   * out of the prompt as well, where it changes what gets written.
   */
  it("keeps it in the draft's context", () => {
    expect(details.map((detail) => detail.label)).toContain(LABEL_COMPATIBILITY);
    expect(customerProductDataBlock(details)).toContain("can it work with my corded pull");
  });

  it("hides the whole section when only hidden labels matched", () => {
    const compatOnly = extractCustomerProductData([inbound("Will it fit my existing bracket?")]);
    expect(compatOnly.length).toBeGreaterThan(0);
    expect(panelCustomerProductData(compatOnly)).toEqual([]);
  });
});
