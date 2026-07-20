<p align="center">
  <img src="assets/pratiquer-logo.png" width="420" alt="Pratiquer — flashcards & educational materials">
</p>

<h1 align="center">Send to Pratiquer</h1>
<p align="center"><em>Practice smarter. Remember longer.</em></p>

Push a vocabulary-list note straight into a [Pratiquer](https://app.pratiquer.co) flashcard set — as a new deck or an existing one — with one command. AI images, TTS narration, auto-translation, and spellcheck run automatically as part of the same send, so a running list in Obsidian turns into a fully-built, ready-to-study deck without ever opening a browser.

## What is Pratiquer?

Pratiquer is a high-performance learning platform for language acquisition, medical terminology, and other memory-heavy subjects. It pairs a state-of-the-art spaced-repetition engine (FSRS v5) with real linguistic intelligence — grammar checking, conjugation tables, offline dictionaries, and AI-generated audio and imagery — so study time goes to the words you're actually about to forget, not the ones you already know. For educators, it's a full course-management layer on top of that same engine: rosters, assignments, a real gradebook, live in-class games, and printable materials.

**🔒 Private beta.** Pratiquer is currently invite-only. Visit **[www.pratiquer.co](https://www.pratiquer.co)** to learn more and join the waitlist.

**Who this plugin is for:** Send to Pratiquer is built for Pratiquer **Educator** and **Independent Learner** accounts — teachers assembling vocabulary lists for a course, and self-directed learners keeping a running study list in Obsidian and sending it into Pratiquer's spaced-repetition engine when it's ready.

## What it sends

- **Network use**: this plugin sends the text of your currently-open note (split one line per flashcard) to the Pratiquer server you configure, along with your API token, whenever you run "Send to Pratiquer." Nothing is sent automatically or in the background — only when you explicitly invoke the command.
- **Source attribution**: each card also records the note's title (e.g. `Captured from Obsidian note "French Trip Vocab"`) in Pratiquer's Notes/Usage Context field, so you can see where a word came from later — no extra vault content beyond the note's own filename, which was already being sent.
- **Requires a Pratiquer account** and an API token generated from Settings → API Access on the Pratiquer web app.
- **No other vault content** is read or transmitted — only the active note at the moment you run the command.

## Install (BRAT)

This plugin isn't in the community plugin directory yet — BRAT is a temporary install path for the private beta, needed only until Pratiquer (and this plugin along with it) is ready for general release. Install it via [BRAT](https://github.com/TfTHacker/obsidian42-brat) (Beta Reviewers Auto-update Tool):

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
3. Choose an existing flashcard set, pick one of your five most recently-used sets, or create a new one — creating a new set also asks which language your list is actually written in (pre-guessed from the note's own text, so this is usually just a confirmation, not a real choice) and which subject to tag it with (Science, History, General Education, ...), the same tagging the web app's set settings offer.
4. Pick which refinements to run (auto-translate, spellcheck, AI/Pixabay image, TTS audio) — this dialog remembers your last choice per-note, so a note you send to repeatedly stays configured the way you like it.
5. Confirm. The plugin reports back how many cards were added once Pratiquer finishes generating them, and flags anything that needs a quick spelling review in the web app.

### Capturing a word in context

A bare line becomes a bare-word card, same as always. But if you're jotting words down as you read rather than keeping a plain list, wrap the word in Obsidian's own `==highlight==` syntax right inside the sentence:

```
Il a couru pour ==attraper== le bus.
```

That line becomes one card for **attraper**, with the whole sentence saved as its usage context — visible in Pratiquer's editor under "Personal Notes & Usage Context." A line with more than one highlighted word makes one card per word, all sharing that sentence as context.

### Changing where a note is headed

Every send shows a **Destination** card naming the flashcard set it's about to add cards to, with a **Change...** button — pick a different existing set or create a new one right there, no need to hand-edit the note's frontmatter. If a note is already bound to a set but you have nothing new to send right now, run **Change destination flashcard set** from the command palette to retarget it directly.

### Resending / a running list

The first time you send a note, the plugin writes a few bookkeeping keys into
that note's YAML frontmatter (`pratiquer-set-id`, `pratiquer-synced-line-count`,
`pratiquer-list-side`, and one `pratiquer-*` key per refinement — `pratiquer-spellcheck`,
`pratiquer-translate`, `pratiquer-image`, `pratiquer-audio`, etc.) — Obsidian shows
these as the note's Properties (checkboxes for on/off refinements, plain text for the
rest), not as raw YAML/JSON. Don't delete them if you plan to keep appending to the list.

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
