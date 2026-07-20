/* ============================================================
   TEST CREATION TEMPLATE (JS format)
   ============================================================
   HOW TO USE THIS FILE:
   1. Copy everything below the line of dashes.
   2. Paste it into Admin → "Paste text / JS" → the text box.
   3. Click "Parse" — you'll land in the normal edit form to
      review everything before saving.

   WHY BACKTICKS (`...`) INSTEAD OF QUOTES ('...' or "..."):
   Every piece of text in this template is wrapped in backticks,
   not regular quotes. This is the single biggest fix for the
   "multiple errors" problem — with regular quotes, an apostrophe
   in your own text (What's, don't, it's) accidentally ends the
   string early and breaks everything after it. Backticks don't
   have this problem — apostrophes and double quotes inside them
   are just normal characters. Keep using backticks as you edit.

   OTHER COMMON MISTAKES TO WATCH FOR:
   - Every question object needs a comma "," after its closing
     "}" — EXCEPT the very last one in the list.
   - Every "{" needs a matching "}", every "[" needs a matching "]".
     If you're not sure, count them, or just duplicate an existing
     whole question block (copy from its { to its matching })
     rather than typing a new one from scratch.
   - correctIndex is the POSITION of the right answer, counting
     from 0. If the options are ["Paris","Lyon","Nice"] and the
     answer is "Paris", correctIndex is 0 (not 1).
   - Don't rename any of the field names on the left of each ":"
     (testCode, title, prompt, points, etc.) — only change the
     values on the right.

   FIELD REFERENCE:
   testCode          — short unique ID, no spaces, e.g. "EN-B2-004"
   title             — shown to takers at the top of the test
   intro             — a sentence or two of instructions
   timeLimitMinutes  — how long the taker gets once they start
   startDate         — optional, "" (empty) = opens immediately.
                        Format: "YYYY-MM-DDTHH:MM:SS"
   deadline          — required, same format as startDate. After
                        this moment nobody can start the test.
   questions         — an ordered list — see the three types below.

   QUESTION TYPES:

   1) Reading or listening PASSAGE — not scored, no answer needed.
      Shown once, followed by whichever questions come right after
      it in this list. Use prompt for text, audioUrl for a clip,
      or both. Leave prompt as `` (empty backticks) for audio-only.
        { type: `passage`, prompt: `...`, audioUrl: `` }

   2) Multiple choice — MC
        {
          type: `mc`,
          prompt: `...`,
          points: 2,
          options: [`...`, `...`, `...`, `...`],
          correctIndex: 0,          // 0 = first option, 1 = second, etc.
          explanation: `...`,        // optional — shown after submission
          audioUrl: ``                // optional
        }

   3) Short written answer — SHORT (not auto-graded)
        {
          type: `short`,
          prompt: `...`,
          points: 5,
          answer: `...`,              // reference answer, for your review only
          explanation: `...`,        // optional
          audioUrl: ``                // optional
        }

   AUDIO URLS: paste a Google Drive share link, a Dropbox link, or
   a direct .mp3/.wav link — the Admin page converts Drive/Dropbox
   links to a playable format automatically when you save.

   A NOTE ON PASSAGES: they rely on staying directly above their
   related questions in this list — don't turn on shuffleQuestions
   in a test that uses them, or the passage could end up separated
   from the questions about it.
   ------------------------------------------------------------ */

const TEST_CONFIG = {
  testCode: `SAMPLE-001`,
  title: `Sample Test — Reading, Listening & General Questions`,
  intro: `This test includes a reading passage, a listening clip, and general questions. Read or listen carefully before answering.`,
  timeLimitMinutes: 40,
  startDate: ``,
  deadline: `2026-09-01T23:59:00`,
  shuffleQuestions: false,
  shuffleOptions: false,

  questions: [

    // ---- Reading passage, followed by two questions about it ----
    {
      type: `passage`,
      prompt: `Many cities have started replacing traditional streetlights with LED lighting. Supporters point out that LEDs use far less electricity and last much longer than older bulbs, which lowers costs for local governments over time. Critics note that some LED installations produce a harsher, colder light than residents are used to, and that the upfront cost of replacing thousands of streetlights can be significant. Even so, more cities are expected to make the switch in the coming years as LED prices continue to fall.`,
      audioUrl: ``
    },
    {
      type: `mc`,
      prompt: `According to the passage, what is one advantage of LED streetlights?`,
      points: 2,
      options: [`They are cheaper to install than old bulbs`, `They use less electricity and last longer`, `They are required by law in most cities`, `They produce warmer light than older bulbs`],
      correctIndex: 1,
      explanation: `The passage states LEDs "use far less electricity and last much longer than older bulbs."`,
      audioUrl: ``
    },
    {
      type: `mc`,
      prompt: `What concern do critics raise about LED streetlights?`,
      points: 2,
      options: [`They break down too quickly`, `They are illegal in some areas`, `The light can feel harsher and installation costs can be high`, `They attract more insects than old bulbs`],
      correctIndex: 2,
      explanation: `The passage mentions "a harsher, colder light" and that "the upfront cost... can be significant."`,
      audioUrl: ``
    },

    // ---- Listening passage (audio-only, no text), one question about it ----
    {
      type: `passage`,
      prompt: ``,
      audioUrl: `https://example.com/replace-with-your-actual-audio-link.mp3`
    },
    {
      type: `short`,
      prompt: `Summarize the main point of the audio clip in two or three sentences.`,
      points: 5,
      answer: `Open answer — assess based on whether the taker accurately captured the clip's main idea.`,
      explanation: ``,
      audioUrl: ``
    },

    // ---- A standalone multiple choice question, unrelated to any passage ----
    {
      type: `mc`,
      prompt: `Which sentence uses the present perfect tense correctly?`,
      points: 2,
      options: [`She live here since 2020.`, `She has lived here since 2020.`, `She living here since 2020.`, `She lived here for 2020.`],
      correctIndex: 1,
      explanation: `The present perfect ("has lived") is used for an action that started in the past and continues now, paired with "since."`,
      audioUrl: ``
    },

    // ---- A standalone short-answer / essay question ----
    {
      type: `short`,
      prompt: `In 100-150 words, describe a change you would like to see in your local community and explain why.`,
      points: 10,
      answer: `Open answer — assess for a clearly stated idea, at least one supporting reason, and overall coherence.`,
      explanation: ``,
      audioUrl: ``
    }

  ]
};
