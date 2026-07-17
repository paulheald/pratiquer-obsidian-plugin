# Send to Pratiquer

Push a vocabulary-list note straight into a [Pratiquer](https://app.pratiquer.co) flashcard set — as a new deck or an existing one — with one command. Optionally generates AI images, TTS audio, and auto-translation for the other side of each card as part of the same send.

**Status: proof of concept.** Built to validate the plugin -> backend integration end-to-end before a wider release. See [`OBSIDIAN_PLUGIN_POC_PLAN.md`](https://github.com/paulheald/flashy_cards/blob/main/docs/development/OBSIDIAN_PLUGIN_POC_PLAN.md) in the main Pratiquer repo for the full design and phased build plan.

## What it sends

- **Network use**: this plugin sends the text of your currently-open note (split one line per flashcard) to the Pratiquer server you configure, along with your API token, whenever you run "Send to Pratiquer." Nothing is sent automatically or in the background — only when you explicitly invoke the command.
- **Requires a Pratiquer account** and an API token generated from Settings → API Access on the Pratiquer web app.
- **No other vault content** is read or transmitted — only the active note at the moment you run the command.

## Install (BRAT)

This plugin isn't in the community plugin directory yet. Install it via [BRAT](https://github.com/TfTHacker/obsidian42-brat) (Beta Reviewers Auto-update Tool):

1. Install the **BRAT** plugin from Obsidian's Community Plugins browser, and enable it.
2. Open BRAT's settings → **Add Beta Plugin**.
3. Paste this repo's URL: `https://github.com/paulheald/pratiquer-obsidian-plugin`
4. Enable **Send to Pratiquer** under Settings → Community Plugins.

## Setup

1. In the Pratiquer web app: **Settings → API Access → Create Token**. Copy the token shown (you won't be able to see it again).
2. In Obsidian: **Settings → Send to Pratiquer**, paste the token, and choose which server to talk to (Production, Local, or a custom URL — switchable any time, no reinstall needed).
3. Click **Test connection** to confirm it works.

## Use

1. Open a note with one vocabulary term per line.
2. Run **Send to Pratiquer** from the command palette, or click the ribbon icon.
3. Choose an existing flashcard set, or create a new one.
4. Pick which refinements to run (auto-translate, AI/Pixabay image, TTS audio) — this dialog remembers your last choice per-note, so a note you send to repeatedly stays configured the way you like it.
5. Confirm. The plugin reports back how many cards were added once Pratiquer finishes generating them.

### Resending / a running list

The first time you send a note, the plugin writes a few bookkeeping keys into
that note's YAML frontmatter (`pratiquer-set-id`, `pratiquer-synced-line-count`,
`pratiquer-refinements`) — Obsidian shows these as the note's Properties, not
as visible text in the note body. Don't delete them if you plan to keep
appending to the list.

On every later send from the same note, the plugin automatically re-targets
the same flashcard set (no picker) and only sends lines **added since the
last send** — so you can keep appending new words to the bottom of a running
list and re-run the command as often as you like without creating duplicate
cards. **Known limitation**: this tracks a line *count*, not line *content* —
inserting a new line above previously-sent ones (rather than appending below
them) will re-send that line as a duplicate. Keep new words at the bottom of
the list.

## Development

```bash
npm install
npm run dev    # watch mode, rebuilds main.js on change
npm run build  # production build + typecheck
```

For local testing, symlink or copy `main.js`, `manifest.json`, and `styles.css` into `<your vault>/.obsidian/plugins/pratiquer/`.
