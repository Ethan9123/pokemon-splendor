# MIT license scope

The MIT license in `LICENSE` applies only to original software implementation
and technical documentation authored by Ethan Fu (Ethan9123), and to contributions
whose copyright holders have authorized distribution under that license.
It does not license the repository as an undifferentiated collection of content.

## Covered implementation

Subject to the exclusions below, the covered work consists of original:

- JavaScript implementation in `js/`, `worker/`, and `sw.js`;
- JavaScript and Python test and development implementation in `test/`;
- Python and JavaScript training and evaluation implementation in `train/`;
- HTML markup in `index.html`, CSS implementation in `css/style.css`, and
  project configuration files;
- Technical documentation describing the implementation and its operation.

Only the authors' original implementation and expression are licensed.
References to third-party content do not license that content. In a file mixing
implementation and third-party content, the MIT grant covers only the original
implementation, not the embedded third-party content.

## Exclusions

The following are outside this project's MIT grant:

1. All files in `assets/`, including card art, card backs, avatars, ball images,
   and `assets/card_index.json`.
2. `apple-touch-icon.png`, `icon-192.png`, and `icon-512.png`.
3. The card databases `js/cards.js`, `js/megas.js`, `js/pokemart.js`,
   `data/cards.json`, `data/megas.json`, and `data/pokemart.json`.
4. Third-party names, characters, artwork, logos, visual designs, rulebook text,
   card descriptions, and mod-derived content, wherever embedded or reproduced,
   including in HTML, CSS, JavaScript, documentation, test fixtures, or training
   data such as `train/parity_states.json`.
5. Third-party software, fonts, libraries, or other dependencies. Any applicable
   upstream license governs those components, not this project's MIT grant.

These exclusions describe the scope of this project's grant; they do not assert
that every name, number, game mechanic, or data item is protected by copyright,
or create restrictions on material that applicable law permits anyone to use.
They do not restrict any rights granted separately by the relevant rightsholders.

No trademark license, endorsement, or authorization to use third-party characters
or visual designs is granted by this project. Original CSS implementation does
not confer rights to a third-party design rendered by that CSS.

## Reuse

The covered code may be used commercially under the MIT license. The maintainer's
description of this project as noncommercial fan work is not a noncommercial
condition on that code. MIT does not require downstream modifications to be
published or contributed back.

The repository includes excluded content needed for the current game experience.
Do not assume that an entire repository copy, deployment, or game distribution
is cleared for reuse merely because the implementation is MIT-licensed. For
reuse, independently establish the rights needed for excluded content, replace
it with appropriately licensed alternatives, or omit it as appropriate.

See `THIRD_PARTY_NOTICES.md` for known provenance and unresolved permissions.
