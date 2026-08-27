import { describe, expect, it } from "vitest";

import { MESSAGE_CATEGORIES, classifyMessageCategory } from "@/lib/knowledge/message-category";

describe("classifyMessageCategory", () => {
  it("names each of the eleven categories from its own signal phrases", () => {
    const examples: Record<string, string> = {
      "Delivery queries": "My parcel still has not arrived and tracking shows nothing.",
      "Pre sales queries": "Before i buy, does it fit a standard socket?",
      "Admin related issues": "Please send me a VAT invoice for this order.",
      "Order change, before shipping queries": "I need to cancel my order before it ships.",
      "Defective items": "The unit is faulty and stopped working after a day.",
      "Damage queries": "The item arrived damaged and the glass is cracked.",
      "Wrong item sent messages": "This is the wrong item, not what i ordered.",
      "Parts missing queries": "There are missing parts in the box, no screws included.",
      "Wrong quantity sent issues": "I only received two instead of the wrong quantity ordered.",
      "Wrong description issues": "The listing says something different — not as described.",
      "Return and refunds": "I would like a refund for this order.",
    };

    for (const category of MESSAGE_CATEGORIES) {
      expect(classifyMessageCategory(examples[category])).toBe(category);
    }
  });

  it("returns null for empty or whitespace-only text, never a guessed category", () => {
    expect(classifyMessageCategory("")).toBeNull();
    expect(classifyMessageCategory("   ")).toBeNull();
    expect(classifyMessageCategory(null)).toBeNull();
  });

  it("returns null when no signal phrase matches, rather than defaulting to one", () => {
    expect(classifyMessageCategory("Thanks so much, that all makes sense now.")).toBeNull();
  });

  it("returns null on a genuine tie between two equally-strong categories", () => {
    // Exactly one phrase each for two different categories -- a real tie,
    // not a guess resolved by array order.
    expect(classifyMessageCategory("It arrived damaged and I would like a refund.")).toBeNull();
  });

  it("matches a signal phrase as a whole word, and does not match it embedded inside a longer word", () => {
    expect(classifyMessageCategory("Where can I read your cancellation policy document?")).toBe(
      "Order change, before shipping queries",
    );
    // "cancellation" must not fire when it is not actually the word present.
    expect(classifyMessageCategory("precancellationxyz is not a real word")).toBeNull();
  });

  it("reads only the text it is given -- pure, no hidden state across calls", () => {
    const first = classifyMessageCategory("My order is damaged.");
    const second = classifyMessageCategory("Thanks, no issues here.");
    expect(first).toBe("Damage queries");
    expect(second).toBeNull();
  });

  it("names each of the eleven categories from its own German signal phrases", () => {
    const examples: Record<string, string> = {
      "Delivery queries": "Mein Paket ist noch nicht angekommen, die Sendungsverfolgung zeigt nichts.",
      "Pre sales queries": "Bevor ich kaufe, passt das in eine Standardfassung?",
      "Admin related issues": "Bitte senden Sie mir eine Mehrwertsteuerrechnung für diese Bestellung.",
      "Order change, before shipping queries": "Ich möchte meine Bestellung stornieren, bevor sie versendet wird.",
      "Defective items": "Das Gerät ist defekt und funktioniert nicht mehr.",
      "Damage queries": "Das Paket kam beschädigt an, das Glas ist gesprungen.",
      "Wrong item sent messages": "Das ist der falsche Artikel, nicht das was ich bestellt habe.",
      "Parts missing queries": "Es fehlen teile in der box, keine schrauben enthalten.",
      "Wrong quantity sent issues": "Ich habe eine falsche menge erhalten, zu wenig erhalten.",
      "Wrong description issues": "Der Artikel ist nicht wie beschrieben, das ist irreführend.",
      "Return and refunds": "Ich möchte eine rückerstattung für diese Bestellung.",
    };

    for (const category of MESSAGE_CATEGORIES) {
      expect(classifyMessageCategory(examples[category])).toBe(category);
    }
  });

  it("does not fire on SMTP/MIME transport header text alone", () => {
    const headerNoise = [
      "Received: from mail.example.com by mx.example.net",
      "Content-Type: text/plain; charset=UTF-8",
      "Authentication-Results: spf=pass smtp.mailfrom=example.com",
      "MIME-Version: 1.0",
      "X-Spam-Status: No, score=-1.0",
    ].join("\n");
    expect(classifyMessageCategory(headerNoise)).toBeNull();
  });

  it("does not fire on automated-notification footer text alone", () => {
    const notificationNoise =
      "This is an automatically generated email from Seller Center. Please do not reply to this message.";
    expect(classifyMessageCategory(notificationNoise)).toBeNull();
  });
});
