# capability/

What the system can and can't actually do, kept honest and current — the plain-language counterpart to the code.

## What belongs here

- Supported-feature notes per marketplace (e.g. eBay is the only marketplace where message direction is a stored field; see root `README.md`'s Scope section)
- Known limitations, stated plainly (e.g. eBay customer messages carry no attachment data at the source — confirmed by investigation, not assumed — so the chat UI cannot show a customer-uploaded photo for eBay today)
- What verified context is available per marketplace (order, product, return) and what it depends on (e.g. return context only appears once a conversation already has a verified single order)
- Capability gaps that would need new source/API integration to close, distinct from gaps that are just unbuilt

## What does not belong here

- Aspirational/planned features — this folder describes what exists *now*, not a roadmap
- Implementation detail — link to the relevant `lib/` module instead of duplicating how it works
