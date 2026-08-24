import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createHarnessServer } from './harness-server.mjs';

const RETRY_PROMPT =
  'E2E ponovni pokušaj: reši jednačinu 2x + 3 = 11.';
const MODEL = 'gemini-3.6-flash';
const IMAGE_MODALITY_MESSAGE =
  'Image input modality is not enabled for models/gemini-3.6-flash-agent';
const UNSUPPORTED_IMAGE_PAYLOAD_MESSAGE =
  'Unsupported image format/MIME';
const HIGH_DEMAND_MESSAGE =
  'gemini-3.6-flash is currently experiencing high demand, spikes in demand are usually temporary. Please try again later.';
const EXPECTED_FOUR_PROFILE_ORDER = [
  ['e2e-api-1', MODEL],
  ['e2e-api-2', MODEL],
  ['e2e-api-3', MODEL],
  ['e2e-api-4', MODEL]
];

const validSolverBody = {
  model: MODEL,
  input: [
    {
      type: 'image',
      mime_type: 'image/jpeg',
      data: Buffer.from('synthetic math image').toString('base64'),
      resolution: 'high'
    },
    {
      type: 'text',
      text: 'Reši zadatak korak po korak.'
    }
  ],
  stream: true,
  store: true,
  system_instruction: 'Test instruction.',
  tools: [{ type: 'code_execution' }],
  generation_config: {
    thinking_level: 'high',
    thinking_summaries: 'auto'
  }
};

async function retrySolverBody() {
  const png = await readFile(
    new URL('./fixtures/linear-equation.png', import.meta.url)
  );
  return {
    ...validSolverBody,
    input: [
      {
        type: 'image',
        mime_type: 'image/png',
        data: png.toString('base64'),
        resolution: 'high'
      },
      {
        type: 'text',
        text: RETRY_PROMPT
      }
    ]
  };
}

function retryEvidence(label, completed = false) {
  return {
    label,
    stage: label,
    loadOrdinal: 2,
    storage: {
      chatFound: true,
      roles: completed ? ['user', 'model'] : ['user'],
      totalMessages: completed ? 2 : 1,
      matchingUserMessages: 1,
      modelMessages: completed ? 1 : 0,
      lastRole: completed ? 'model' : 'user',
      savedPrompt: RETRY_PROMPT,
      hadImage: true,
      imageIdPresent: true,
      completedModels: completed ? 1 : 0
    },
    indexedImage: {
      found: true,
      mimeType: 'image/png',
      bytes: 4732
    },
    dom: {
      userBubbles: 1,
      matchingUserBubbles: 1,
      modelBubbles: completed ? 1 : 0,
      completedModels: completed ? 1 : 0,
      promptValue: '',
      sendDisabled: false
    }
  };
}

async function postRetryEvidence(base, run, evidence) {
  const response = await fetch(
    base +
      '/__harness__/client-evidence?scenario=retry-after-reload&run=' +
      encodeURIComponent(run),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(evidence)
    }
  );
  assert.equal(response.status, 200);
}

async function postSolver(base, endpoint, body, apiKey, signal) {
  return fetch(base + endpoint, {
    method: 'POST',
    headers: {
      Accept: 'text/event-stream',
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey
    },
    body: JSON.stringify(body),
    signal
  });
}

function solverBodyForModel(model) {
  return {
    ...validSolverBody,
    model
  };
}

async function withServer(run) {
  const harness = createHarnessServer();
  await new Promise(resolve =>
    harness.server.listen(0, '127.0.0.1', resolve)
  );
  const address = harness.server.address();
  const base = 'http://127.0.0.1:' + address.port;
  try {
    await run(base, harness);
  } finally {
    await new Promise(resolve => harness.server.close(resolve));
  }
}

async function frontendSource() {
  return readFile(
    new URL('../../src/math-app.html', import.meta.url),
    'utf8'
  );
}

function sourceSlice(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, 'expected frontend source slice');
  return source.slice(start, end);
}

async function frontendRenderer() {
  const source = await frontendSource();
  const rendererSource = sourceSlice(
    source,
    '  function escapeHtml',
    '  function plainMathFallbackString'
  );
  return new Function(
    rendererSource +
      '\nreturn {' +
      'markdownToHtml' +
      '};'
  )();
}

function accidentalSchoolFence(marker = '```', language = '') {
  return [
    marker + language,
    '### Drugi interval: \\(-2 \\le x < 1\\)',
    '',
    'Tada je \\(|x - 1| = 1 - x\\) i zato računamo razliku.',
    '',
    '\\[',
    '(1 - x) - (x + 2) = -2x - 1',
    '\\]',
    '',
    'Pošto proverom dobijamo jednakost, ovo je **važeće rešenje**.',
    marker
  ].join('\n');
}

test('renderer repairs accidental fenced and indented school explanations', async () => {
  const { markdownToHtml } = await frontendRenderer();
  const variants = [
    accidentalSchoolFence(),
    accidentalSchoolFence('~~~'),
    accidentalSchoolFence('```', 'text'),
    accidentalSchoolFence('```', 'latex'),
    accidentalSchoolFence().replace(/\n```$/, '\n````'),
    accidentalSchoolFence().replace(/\n/g, '\r\n'),
    accidentalSchoolFence() +
      '\n\n**Treći interval:** \\(x \\ge 1\\)\n\n' +
      accidentalSchoolFence('~~~'),
    accidentalSchoolFence()
      .split('\n')
      .slice(1, -1)
      .map(line => line ? '    ' + line : '')
      .join('\n'),
    accidentalSchoolFence()
      .split('\n')
      .slice(1, -1)
      .map(line => line ? '\t' + line : '')
      .join('\n')
  ];

  for (const source of variants) {
    const html = markdownToHtml(source, true);
    assert.doesNotMatch(html, /<pre\b|<code\b|```|~~~/);
    assert.match(html, /<h3>Drugi interval:/);
    assert.match(html, /class="mathInlineRaw"/);
    assert.match(html, /class="mathBlockRaw"/);
    assert.match(html, /<strong>važeće rešenje<\/strong>/);
    assert.match(html, /Pošto proverom/);
  }

  const cyrillic = [
    '```',
    '### Решење задатка',
    'Тада добијамо исправну вредност.',
    '\\[',
    'x = 2',
    '\\]',
    'Дакле, провера једнакости важи и ово је **тачно решење**.',
    '```'
  ].join('\r\n');
  const cyrillicHtml = markdownToHtml(cyrillic, true);
  assert.doesNotMatch(cyrillicHtml, /<pre\b|<code\b|```/);
  assert.match(cyrillicHtml, /<h3>Решење задатка/);
  assert.match(cyrillicHtml, /class="mathBlockRaw"/);
  assert.match(cyrillicHtml, /<strong>тачно решење<\/strong>/);
});

test('renderer repairs an unfinished streamed school fence deterministically', async () => {
  const { markdownToHtml } = await frontendRenderer();
  const completed = accidentalSchoolFence();
  const unfinished = completed.split('\n').slice(0, -1).join('\n');

  assert.match(markdownToHtml(unfinished, false), /<pre><code/);
  assert.match(markdownToHtml(completed, false), /<pre><code/);
  assert.equal(
    markdownToHtml(unfinished, true),
    markdownToHtml(completed, true)
  );
  assert.doesNotMatch(markdownToHtml(unfinished, true), /<pre\b|<code\b|```/);
});

test('renderer preserves genuine code and escapes hostile accidental prose', async () => {
  const { markdownToHtml } = await frontendRenderer();
  const javascript = [
    '```javascript',
    'const formula = "\\\\[x = 2\\\\]";',
    'console.log(formula);',
    '```'
  ].join('\n');
  const unlabeledCode = [
    '```',
    'function solve() {',
    '  const formula = "\\\\[x = 2\\\\]";',
    '  return formula;',
    '}',
    '```'
  ].join('\n');
  const indentedPython = [
    '    formula = "\\\\[x = 2\\\\]"',
    '    print(formula)'
  ].join('\n');
  const indentedAssignments = [
    '    title = "**Važeće rešenje**"',
    '    formula = "\\\\(x = 2\\\\)"',
    '    note = "Tada proveravamo vrednost"'
  ].join('\n');
  const indentedBareLatex = [
    '    formula = \\frac{1}{2}',
    '    result = formula'
  ].join('\n');
  const cyrillicAssignments = [
    '    наслов = "Важеће решење задатка"',
    '    формула = "\\\\(x = 2\\\\)"',
    '    напомена = "Тада провером добијамо вредност"'
  ].join('\n');
  const quotedAssignments = [
    '    "наслов" = "Важеће решење задатка"',
    '    \'formula\' = "\\\\(x = 2\\\\)"',
    '    "note" = "Тада провером добијамо вредност"'
  ].join('\n');
  const json = [
    '    {',
    '      "formula": "\\\\[x = 2\\\\]",',
    '      "valid": true',
    '    }'
  ].join('\n');
  const yaml = [
    '    title: "Važeće rešenje zadatka"',
    '    formula: "\\\\(x = 2\\\\)"',
    '    note: "Tada proverom dobijamo vrednost"'
  ].join('\n');
  const htmlSample = [
    '    <section class="rešenje">',
    '      <strong>Važeće rešenje zadatka</strong>',
    '      <span data-formula="\\\\(x = 2\\\\)">Tada proverom dobijamo vrednost</span>',
    '    </section>'
  ].join('\n');
  const cyrillicYaml = [
    '    наслов: "Важеће решење задатка"',
    '    формула: "\\\\(x = 2\\\\)"',
    '    напомена: "Тада провером добијамо вредност"'
  ].join('\n');
  const quotedCyrillicYaml = [
    '    "наслов": "Важеће решење задатка"',
    '    "формула": "\\\\(x = 2\\\\)"',
    '    \'напомена\': "Тада провером добијамо вредност"'
  ].join('\n');
  const yamlList = [
    '    - title: "Važeće rešenje zadatka"',
    '    - formula: "\\\\(x = 2\\\\)"',
    '    - note: "Tada proverom dobijamo vrednost"'
  ].join('\n');
  const orderedListSource = [
    '    1. Važeće rešenje zadatka',
    '    2. Tada primenjujemo \\\\(x = 2\\\\)',
    '    3. Dakle proverom dobijamo vrednost'
  ].join('\n');

  const javascriptHtml = markdownToHtml(javascript, true);
  assert.match(javascriptHtml, /<pre><code data-lang="javascript">/);
  assert.doesNotMatch(javascriptHtml, /math(?:Block|Inline)Raw/);
  assert.match(javascriptHtml, /console\.log\(formula\);/);

  const unfinishedJavascript = javascript.split('\n').slice(0, -1).join('\n');
  assert.match(markdownToHtml(unfinishedJavascript, true), /<pre><code data-lang="javascript">/);

  for (const source of [
    unlabeledCode,
    indentedPython,
    indentedAssignments,
    indentedBareLatex,
    cyrillicAssignments,
    quotedAssignments,
    json,
    yaml,
    htmlSample,
    cyrillicYaml,
    quotedCyrillicYaml,
    yamlList,
    orderedListSource
  ]) {
    const html = markdownToHtml(source, true);
    assert.match(html, /<pre><code/);
    assert.doesNotMatch(html, /math(?:Block|Inline)Raw/);
  }

  const yamlHtml = markdownToHtml(yaml, true);
  assert.equal(
    yamlHtml,
    '<pre><code data-lang="">title: &quot;Važeće rešenje zadatka&quot;\n' +
      'formula: &quot;\\\\(x = 2\\\\)&quot;\n' +
      'note: &quot;Tada proverom dobijamo vrednost&quot;</code></pre>'
  );
  const htmlSampleHtml = markdownToHtml(htmlSample, true);
  assert.equal(
    htmlSampleHtml,
    '<pre><code data-lang="">&lt;section class=&quot;rešenje&quot;&gt;\n' +
      '  &lt;strong&gt;Važeće rešenje zadatka&lt;/strong&gt;\n' +
      '  &lt;span data-formula=&quot;\\\\(x = 2\\\\)&quot;&gt;Tada proverom dobijamo vrednost&lt;/span&gt;\n' +
      '&lt;/section&gt;</code></pre>'
  );
  assert.equal(
    markdownToHtml(cyrillicYaml, true),
    '<pre><code data-lang="">наслов: &quot;Важеће решење задатка&quot;\n' +
      'формула: &quot;\\\\(x = 2\\\\)&quot;\n' +
      'напомена: &quot;Тада провером добијамо вредност&quot;</code></pre>'
  );
  assert.equal(
    markdownToHtml(cyrillicAssignments, true),
    '<pre><code data-lang="">наслов = &quot;Важеће решење задатка&quot;\n' +
      'формула = &quot;\\\\(x = 2\\\\)&quot;\n' +
      'напомена = &quot;Тада провером добијамо вредност&quot;</code></pre>'
  );
  assert.equal(
    markdownToHtml(quotedAssignments, true),
    '<pre><code data-lang="">&quot;наслов&quot; = &quot;Важеће решење задатка&quot;\n' +
      "'formula' = &quot;\\\\(x = 2\\\\)&quot;\n" +
      '&quot;note&quot; = &quot;Тада провером добијамо вредност&quot;</code></pre>'
  );
  assert.equal(
    markdownToHtml(quotedCyrillicYaml, true),
    '<pre><code data-lang="">&quot;наслов&quot;: &quot;Важеће решење задатка&quot;\n' +
      '&quot;формула&quot;: &quot;\\\\(x = 2\\\\)&quot;\n' +
      "'напомена': &quot;Тада провером добијамо вредност&quot;</code></pre>"
  );
  assert.equal(
    markdownToHtml(yamlList, true),
    '<pre><code data-lang="">- title: &quot;Važeće rešenje zadatka&quot;\n' +
      '- formula: &quot;\\\\(x = 2\\\\)&quot;\n' +
      '- note: &quot;Tada proverom dobijamo vrednost&quot;</code></pre>'
  );
  assert.equal(
    markdownToHtml(orderedListSource, true),
    '<pre><code data-lang="">1. Važeće rešenje zadatka\n' +
      '2. Tada primenjujemo \\\\(x = 2\\\\)\n' +
      '3. Dakle proverom dobijamo vrednost</code></pre>'
  );

  const nestedRenderedList = [
    '- Prvi korak',
    '    Kratko objašnjenje roditeljske stavke.',
    '',
    '    - Tada primeni \\(x = 2\\)',
    '    - Dakle proveri vrednost',
    '1. Drugi korak',
    '    1. Tada proveri \\(x = 2\\)'
  ].join('\n');
  const nestedRenderedListHtml = markdownToHtml(nestedRenderedList, true);
  assert.doesNotMatch(nestedRenderedListHtml, /<pre\b|<code\b/);
  assert.equal(
    (nestedRenderedListHtml.match(/class="mdListItem"/g) || []).length,
    5
  );
  assert.equal(
    (nestedRenderedListHtml.match(/class="mathInlineRaw"/g) || []).length,
    2
  );

  const deepNestedRenderedList = [
    '- L0',
    '  nastavak nultog nivoa',
    '    - L1',
    '      nastavak prvog nivoa',
    '        1. L2 \\(x = 2\\)'
  ].join('\n');
  const deepNestedRenderedListHtml = markdownToHtml(deepNestedRenderedList, true);
  assert.doesNotMatch(deepNestedRenderedListHtml, /<pre\b|<code\b/);
  assert.equal(
    (deepNestedRenderedListHtml.match(/class="mdListItem"/g) || []).length,
    3
  );
  assert.equal(
    (deepNestedRenderedListHtml.match(/class="mathInlineRaw"/g) || []).length,
    1
  );

  const genuineCodeInsideList = [
    '- Parent',
    '',
    '      formula = "\\\\(x = 2\\\\)"',
    '      print(formula)'
  ].join('\n');
  const genuineCodeInsideListHtml = markdownToHtml(genuineCodeInsideList, true);
  assert.match(genuineCodeInsideListHtml, /<pre><code data-lang="">/);
  assert.match(genuineCodeInsideListHtml, /formula = &quot;\\\\\(x = 2\\\\\)&quot;/);
  assert.match(genuineCodeInsideListHtml, /print\(formula\)/);
  assert.doesNotMatch(genuineCodeInsideListHtml, /math(?:Block|Inline)Raw/);

  const bulletCodeInsideList = [
    '- Parent',
    '',
    '      - title: "Važeće rešenje zadatka"',
    '      - formula: "\\\\(x = 2\\\\)"',
    '      - note: "Tada proverom dobijamo vrednost"'
  ].join('\n');
  assert.equal(
    markdownToHtml(bulletCodeInsideList, true),
    '<div class="mdListItem" style="margin-left:0px"><span class="mdListMarker">•</span><div class="mdListBody">Parent</div></div>' +
      '<pre><code data-lang="">- title: &quot;Važeće rešenje zadatka&quot;\n' +
      '- formula: &quot;\\\\(x = 2\\\\)&quot;\n' +
      '- note: &quot;Tada proverom dobijamo vrednost&quot;</code></pre>'
  );

  const orderedCodeInsideList = [
    '1. Parent',
    '',
    '       1. Važeće rešenje zadatka',
    '       2. Tada primenjujemo \\\\(x = 2\\\\)',
    '       3. Dakle proverom dobijamo vrednost'
  ].join('\n');
  assert.equal(
    markdownToHtml(orderedCodeInsideList, true),
    '<div class="mdListItem" style="margin-left:0px"><span class="mdListMarker">1.</span><div class="mdListBody">Parent</div></div>' +
      '<pre><code data-lang="">1. Važeće rešenje zadatka\n' +
      '2. Tada primenjujemo \\\\(x = 2\\\\)\n' +
      '3. Dakle proverom dobijamo vrednost</code></pre>'
  );

  const bulletCodeAfterClosedList = [
    '- Parent',
    '',
    '',
    '    - title: "Važeće rešenje zadatka"',
    '    - formula: "\\\\(x = 2\\\\)"',
    '    - note: "Tada proverom dobijamo vrednost"'
  ].join('\n');
  assert.equal(
    markdownToHtml(bulletCodeAfterClosedList, true),
    '<div class="mdListItem" style="margin-left:0px"><span class="mdListMarker">•</span><div class="mdListBody">Parent</div></div>' +
      '<pre><code data-lang="">- title: &quot;Važeće rešenje zadatka&quot;\n' +
      '- formula: &quot;\\\\(x = 2\\\\)&quot;\n' +
      '- note: &quot;Tada proverom dobijamo vrednost&quot;</code></pre>'
  );

  const orderedCodeAfterClosedList = [
    '1. Parent',
    '',
    '',
    '    1. Važeće rešenje zadatka',
    '    2. Tada primenjujemo \\\\(x = 2\\\\)',
    '    3. Dakle proverom dobijamo vrednost'
  ].join('\n');
  assert.equal(
    markdownToHtml(orderedCodeAfterClosedList, true),
    '<div class="mdListItem" style="margin-left:0px"><span class="mdListMarker">1.</span><div class="mdListBody">Parent</div></div>' +
      '<pre><code data-lang="">1. Važeće rešenje zadatka\n' +
      '2. Tada primenjujemo \\\\(x = 2\\\\)\n' +
      '3. Dakle proverom dobijamo vrednost</code></pre>'
  );

  const fencedJavascriptInsideList = [
    '- Primer koda:',
    '    ```javascript',
    '    const formula = "\\\\(x = 2\\\\)";',
    '    console.log(formula);',
    '    ```'
  ].join('\n');
  const fencedJavascriptInsideListHtml = markdownToHtml(
    fencedJavascriptInsideList,
    true
  );
  assert.match(
    fencedJavascriptInsideListHtml,
    /<pre><code data-lang="javascript">/
  );
  assert.match(fencedJavascriptInsideListHtml, /const formula = &quot;/);
  assert.match(fencedJavascriptInsideListHtml, /console\.log\(formula\);/);
  assert.doesNotMatch(
    fencedJavascriptInsideListHtml,
    /math(?:Block|Inline)Raw|```/
  );

  const deepFencedCodeInsideList = [
    '- L0',
    '    - L1',
    '        ```python',
    '        formula = "\\\\(x = 2\\\\)"',
    '        print(formula)',
    '        ```'
  ].join('\n');
  const deepFencedCodeInsideListHtml = markdownToHtml(
    deepFencedCodeInsideList,
    true
  );
  assert.equal(
    (deepFencedCodeInsideListHtml.match(/class="mdListItem"/g) || []).length,
    2
  );
  assert.match(deepFencedCodeInsideListHtml, /<pre><code data-lang="python">/);
  assert.match(deepFencedCodeInsideListHtml, /print\(formula\)/);
  assert.doesNotMatch(
    deepFencedCodeInsideListHtml,
    /math(?:Block|Inline)Raw|```/
  );

  const dedentedFenceInAncestorList = [
    '- Root',
    '    - Child',
    '     ```javascript',
    '     const formula = "\\\\(x = 2\\\\)";',
    '     console.log(formula);',
    '     ```'
  ].join('\n');
  const dedentedFenceInAncestorListHtml = markdownToHtml(
    dedentedFenceInAncestorList,
    true
  );
  assert.equal(
    (dedentedFenceInAncestorListHtml.match(/class="mdListItem"/g) || []).length,
    2
  );
  assert.match(
    dedentedFenceInAncestorListHtml,
    /<pre><code data-lang="javascript">/
  );
  assert.match(dedentedFenceInAncestorListHtml, /console\.log\(formula\);/);
  assert.doesNotMatch(
    dedentedFenceInAncestorListHtml,
    /math(?:Block|Inline)Raw|```/
  );

  const longNestedList = [
    '- Roditeljska stavka',
    ...Array.from(
      {length: 4000},
      (_, index) => `    - Korak ${index + 1}: \\(x = ${index + 1}\\)`
    )
  ].join('\n');
  const longListStartedAt = performance.now();
  const longNestedListHtml = markdownToHtml(longNestedList, true);
  const longListDuration = performance.now() - longListStartedAt;
  assert.equal(
    (longNestedListHtml.match(/class="mdListItem"/g) || []).length,
    4001
  );
  assert.equal(
    (longNestedListHtml.match(/class="mathInlineRaw"/g) || []).length,
    4000
  );
  assert.ok(
    longListDuration < 1200,
    `long nested list must render linearly; took ${longListDuration.toFixed(1)}ms`
  );

  const inlineStressSource = Array.from(
    {length: 4000},
    (_, index) => `<sup>${index + 1}</sup> \\*`
  ).join(' ');
  const inlineStressStartedAt = performance.now();
  const inlineStressHtml = markdownToHtml(inlineStressSource, true);
  const inlineStressDuration = performance.now() - inlineStressStartedAt;
  assert.equal((inlineStressHtml.match(/<sup>/g) || []).length, 4000);
  assert.equal((inlineStressHtml.match(/<\/sup>/g) || []).length, 4000);
  assert.doesNotMatch(inlineStressHtml, /@@(?:SAFEHTML|ESC)\d+@@/);
  assert.ok(
    inlineStressDuration < 700,
    `inline placeholders must render linearly; took ${inlineStressDuration.toFixed(1)}ms`
  );

  const pureLatex = ['```latex', '\\frac{2}{5} = 0{,}4', '```'].join('\n');
  const latexHtml = markdownToHtml(pureLatex, true);
  assert.doesNotMatch(latexHtml, /<pre\b|<code\b/);
  assert.match(latexHtml, /class="mathBlockRaw"/);

  const nestedFence = [
    '````markdown',
    'Primer sintakse sa pravim unutrašnjim kodom i formulom \\(x = 2\\):',
    '```text',
    '    title = "**Važeće rešenje**"',
    '    formula = "\\\\(x = 2\\\\)"',
    '```',
    '````'
  ].join('\n');
  const nestedFenceHtml = markdownToHtml(nestedFence, true);
  assert.match(nestedFenceHtml, /<pre><code data-lang="markdown">/);
  assert.match(nestedFenceHtml, /    title = &quot;\*\*Važeće rešenje\*\*&quot;/);
  assert.doesNotMatch(nestedFenceHtml, /math(?:Block|Inline)Raw/);

  const longerJavascriptCloser = javascript.replace(/\n```$/, '\n````');
  const longerCloserHtml = markdownToHtml(longerJavascriptCloser, true);
  assert.match(longerCloserHtml, /<pre><code data-lang="javascript">/);
  assert.match(longerCloserHtml, /console\.log\(formula\);/);

  const proseOnly = [
    '```text',
    'Ovo je samo citirani tekst bez matematičkih delimitera.',
    'I zato nije bezbedno nagađati da fence sigurno predstavlja grešku.',
    '```'
  ].join('\n');
  assert.match(markdownToHtml(proseOnly, true), /<pre><code data-lang="text">/);

  const literalMarkdown = [
    '```markdown',
    '### Uputstvo',
    '**Tada primeni formulu:** \\(x = 2\\)',
    'Ovo je doslovni Markdown primer za školski zadatak.',
    '```'
  ].join('\n');
  assert.match(markdownToHtml(literalMarkdown, true), /<pre><code data-lang="markdown">/);

  const hostile = accidentalSchoolFence()
    .replace(
      'Pošto proverom',
      '<script>globalThis.__rendererPwned = true<\/script> ' +
        '<img src=x onerror="globalThis.__rendererPwned = true"> ' +
        '[klik](javascript:alert(1)) Pošto proverom'
    );
  const hostileHtml = markdownToHtml(hostile, true);
  assert.doesNotMatch(hostileHtml, /<script\b|<img\b|href="javascript:/i);
  assert.match(hostileHtml, /&lt;script&gt;/);
  assert.match(hostileHtml, /&lt;img src=x onerror=&quot;/);

  const hostileLanguage = [
    '```"><img src=x onerror=alert(1)>',
    'plain output',
    '```'
  ].join('\n');
  const hostileLanguageHtml = markdownToHtml(hostileLanguage, true);
  assert.match(hostileLanguageHtml, /<pre><code data-lang=/);
  assert.doesNotMatch(hostileLanguageHtml, /<img\b/);
  assert.match(hostileLanguageHtml, /&quot;&gt;&lt;img/);
});

test('local API file parser accepts 1-4 safe lines and rejects invalid input', async () => {
  const source = await frontendSource();
  const parserSource = sourceSlice(
    source,
    '  function parseLocalApiKeyText',
    '  function normalizeLocalApiProfile'
  );
  const parse = new Function(
    'MAX_LOCAL_API_FILE_BYTES',
    'API_SLOT_ORDER',
    parserSource + '\nreturn parseLocalApiKeyText;'
  )(16 * 1024, Object.freeze([1, 2, 3, 4]));

  const keys = [
    'fake-local-key-1',
    'fake-local-key-2',
    'fake-local-key-3',
    'fake-local-key-4'
  ];
  assert.deepEqual(
    parse('\uFEFF' + keys[0] + '\r\n\r\n' + keys[1] + '\n' + keys[2] + '\r' + keys[3] + '\n'),
    keys
  );
  assert.deepEqual(parse(keys[0]), [keys[0]]);
  assert.throws(() => parse(' \r\n\n '), /nijedan API ključ/);
  assert.throws(() => parse([...keys, 'fake-local-key-5'].join('\n')), /najviše četiri/);
  assert.throws(() => parse('fake local key'), /neispravan red/);
  assert.throws(() => parse('fake-local\u0000-key'), /neispravan red/);
  assert.throws(() => parse(keys[0] + '\n' + keys[0]), /više puta/);
});

test('file import replaces all slots and local profiles fully replace gateway selection', async () => {
  const source = await frontendSource();
  const parserSource = sourceSlice(
    source,
    '  function parseLocalApiKeyText',
    '  function normalizeLocalApiProfile'
  );
  const parse = new Function(
    'MAX_LOCAL_API_FILE_BYTES',
    'API_SLOT_ORDER',
    parserSource + '\nreturn parseLocalApiKeyText;'
  )(16 * 1024, Object.freeze([1, 2, 3, 4]));
  const importerSource = sourceSlice(
    source,
    '  async function importLocalApiKeyFile',
    '  function populateLocalApiDialog'
  );
  const applied = [];
  const importFile = new Function(
    'MAX_LOCAL_API_FILE_BYTES',
    'API_SLOT_ORDER',
    'parseLocalApiKeyText',
    'applyLocalApiProfiles',
    'busy',
    'sendPreparing',
    importerSource + '\nreturn importLocalApiKeyFile;'
  )(
    16 * 1024,
    Object.freeze([1, 2, 3, 4]),
    parse,
    profiles => {
      applied.push(structuredClone(profiles));
      return { saved: profiles, configured: profiles.filter(item => item.key).length };
    },
    false,
    false
  );

  const imported = await importFile({
    size: 64,
    text: async () => 'fake-local-key-1\nfake-local-key-2\n'
  });
  assert.equal(imported.configured, 2);
  assert.deepEqual(
    applied[0].map(profile => [profile.transport, profile.slot, profile.key]),
    [
      ['local', 1, 'fake-local-key-1'],
      ['local', 2, 'fake-local-key-2'],
      ['local', 3, ''],
      ['local', 4, '']
    ]
  );
  await assert.rejects(
    importFile({
      size: 128,
      text: async () => [1, 2, 3, 4, 5].map(n => 'fake-local-key-' + n).join('\n')
    }),
    /najviše četiri/
  );
  let oversizedFileRead = false;
  await assert.rejects(
    importFile({
      size: 16 * 1024 + 1,
      text: async () => {
        oversizedFileRead = true;
        return 'fake-local-key-1';
      }
    }),
    /prevelik/
  );
  assert.equal(oversizedFileRead, false);
  assert.equal(applied.length, 1);

  const selectionSource = sourceSlice(
    source,
    '  function getApiProfiles()',
    '  function apiProfileId'
  );
  const selectProfiles = localProfiles => new Function(
    'API_SLOT_ORDER',
    'getConfiguredLocalApiProfiles',
    selectionSource + '\nreturn getApiProfiles();'
  )(
    Object.freeze([1, 2, 3, 4]),
    () => localProfiles
  );
  const sparseLocal = [applied[0][1], applied[0][3]].map((profile, index) => ({
    ...profile,
    key: 'sparse-local-key-' + index
  }));
  assert.deepEqual(selectProfiles(sparseLocal), sparseLocal);
  assert.deepEqual(
    selectProfiles([]),
    [1, 2, 3, 4].map(slot => ({ transport: 'gateway', slot }))
  );

  const profileIdSource = sourceSlice(
    source,
    '  function apiProfileId',
    '  function setStatus'
  );
  const bucketIdSource = sourceSlice(
    source,
    '  function localApiBucketId',
    '  let localRateMemoryState'
  );
  const profileId = new Function(
    bucketIdSource + '\n' + profileIdSource + '\nreturn apiProfileId;'
  )();
  assert.equal(profileId({ transport: 'gateway', slot: 2 }), 'gateway:2');
  const oldCredentialId = profileId({
    transport: 'local',
    slot: 1,
    key: 'fake-local-key-old'
  });
  const newCredentialId = profileId({
    transport: 'local',
    slot: 1,
    key: 'fake-local-key-new'
  });
  assert.match(oldCredentialId, /^local:1:[^:]+:\d+$/);
  assert.notEqual(oldCredentialId, newCredentialId);
  assert.equal(
    oldCredentialId,
    profileId({ transport: 'local', slot: 1, key: 'fake-local-key-old' })
  );
});

test('serves an injected app without modifying the production file', async () => {
  await withServer(async base => {
    const response = await fetch(base + '/docs/?scenario=success&fresh=1');
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /math-e2e-bootstrap/);
    assert.match(html, /__mock\/gateway\/v1\/interactions/);
    assert.doesNotMatch(html, /matematika_google_api_profiles_v1/);
    assert.doesNotMatch(html, /api_key_persistent_v1/);

    const fixture = await fetch(
      base + '/tests/e2e/fixtures/linear-equation.png'
    );
    assert.equal(fixture.status, 200);
    assert.equal(fixture.headers.get('content-type'), 'image/png');
    const bytes = new Uint8Array(await fixture.arrayBuffer());
    assert.deepEqual(
      [...bytes.slice(0, 8)],
      [137, 80, 78, 71, 13, 10, 26, 10]
    );

    const retryPage = await fetch(
      base + '/docs/?scenario=retry-after-reload&fresh=1&run=inject-test'
    );
    const retryHtml = await retryPage.text();
    assert.match(retryHtml, /retry-after-reload-driver\.js/);
    assert.match(retryHtml, /Document\.prototype\.write/);

    const retryDriver = await fetch(
      base + '/__harness__/retry-after-reload-driver.js'
    );
    assert.equal(retryDriver.status, 200);
    assert.equal(
      retryDriver.headers.get('content-type'),
      'text/javascript; charset=utf-8'
    );
    assert.match(await retryDriver.text(), /__MATH_E2E_RETRY__/);
  });
});

test('success SSE emits thought, model output, and completion', async () => {
  await withServer(async base => {
    const response = await fetch(
      base +
        '/__mock/gemini/v1beta/interactions?alt=sse&scenario=success',
      {
        method: 'POST',
        headers: {
          Accept: 'text/event-stream',
          'Content-Type': 'application/json',
          'x-goog-api-key': 'e2e-api-1'
        },
        body: JSON.stringify(validSolverBody)
      }
    );

    assert.equal(response.status, 200);
    const stream = await response.text();
    assert.match(stream, /thought_summary/);
    assert.match(stream, /model_output/);
    assert.match(stream, /interaction\.completed/);

    const assertions = await fetch(
      base + '/__harness__/assertions?scenario=success'
    ).then(item => item.json());
    assert.equal(assertions.ok, true);
    assert.equal(assertions.requests[0].checks.noGoogleSearchOrGrounding, true);
  });
});

test('request oracle rejects an agent alias and media_resolution impostor', async () => {
  await withServer(async base => {
    const invalidBody = {
      ...validSolverBody,
      model: 'gemini-3.6-flash-agent',
      input: validSolverBody.input.map(part =>
        part.type === 'image'
          ? {
              type: part.type,
              mime_type: part.mime_type,
              data: part.data,
              media_resolution: 'high'
            }
          : { ...part }
      )
    };
    const response = await postSolver(
      base,
      '/__mock/gemini/v1beta/interactions?alt=sse&scenario=success',
      invalidBody,
      'e2e-api-1'
    );
    await response.text();

    const assertions = await fetch(
      base + '/__harness__/assertions?scenario=success'
    ).then(item => item.json());
    assert.equal(assertions.ok, false);
    assert.equal(assertions.requests[0].checks.model, false);
    assert.equal(assertions.requests[0].checks.imageResolutionHigh, false);
  });
});

test('fallback scenario keeps API 1 at 429 and lets API 2 stream', async () => {
  await withServer(async base => {
    const endpoint =
      base +
      '/__mock/gemini/v1beta/interactions?alt=sse&scenario=fallback-429';

    const first = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Accept: 'text/event-stream',
        'Content-Type': 'application/json',
        'x-goog-api-key': 'e2e-api-1'
      },
      body: JSON.stringify(validSolverBody)
    });
    assert.equal(first.status, 429);

    const second = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Accept: 'text/event-stream',
        'Content-Type': 'application/json',
        'x-goog-api-key': 'e2e-api-2'
      },
      body: JSON.stringify(validSolverBody)
    });
    assert.equal(second.status, 200);
    assert.match(await second.text(), /interaction\.completed/);

    const assertions = await fetch(
      base + '/__harness__/assertions?scenario=fallback-429'
    ).then(item => item.json());
    assert.equal(assertions.ok, true);
    assert.equal(assertions.scenarioChecks.api1Returned429, true);
    assert.equal(assertions.scenarioChecks.api2Completed, true);
  });
});

test('fallback follows the exact four-key 3.6 order', async () => {
  await withServer(async base => {
    const run = 'four-profile-order';
    const endpoint =
      '/__mock/gemini/v1beta/interactions?alt=sse' +
      '&scenario=fallback-four&run=' + run;

    for (let index = 0; index < EXPECTED_FOUR_PROFILE_ORDER.length; index++) {
      const [apiKey, model] = EXPECTED_FOUR_PROFILE_ORDER[index];
      const response = await postSolver(
        base,
        endpoint,
        solverBodyForModel(model),
        apiKey
      );

      if (index < 3) {
        assert.equal(response.status, 401);
      } else {
        assert.equal(response.status, 200);
        assert.match(await response.text(), /interaction\.completed/);
      }
    }

    const assertions = await fetch(
      base +
        '/__harness__/assertions?scenario=fallback-four&run=' +
        run
    ).then(item => item.json());

    assert.equal(assertions.ok, true);
    assert.deepEqual(assertions.scenarioChecks, {
      exactFourProfileOrder: true,
      firstThreeWereClassifiedFailures: true,
      fourthProfileCompleted: true
    });
    assert.equal(assertions.counts.solverRequests, 4);
    assert.equal(
      assertions.requests.every(request =>
        request.checks.model &&
        request.checks.thinkingLevel &&
        request.checks.thinkingSummaries &&
        request.checks.toolsExactlyCodeExecution &&
        request.checks.noGoogleSearchOrGrounding &&
        request.checks.imagePayload &&
        request.checks.imageResolutionHigh
      ),
      true
    );
  });
});

test('single-line SSE modality error advances to the next ordered tuple', async () => {
  await withServer(async base => {
    const run = 'single-line-modality-error';
    const endpoint =
      '/__mock/gemini/v1beta/interactions?alt=sse' +
      '&scenario=sse-error-next-profile&run=' + run;
    const first = await postSolver(
      base,
      endpoint,
      solverBodyForModel(MODEL),
      'e2e-api-1'
    );
    assert.equal(first.status, 200);
    const wire = await first.text();
    const nonEmptyLines = wire.split(/\r?\n/).filter(Boolean);
    assert.equal(nonEmptyLines.length, 1);
    assert.match(nonEmptyLines[0], /"event_type":"error"/);
    assert.match(nonEmptyLines[0], new RegExp(IMAGE_MODALITY_MESSAGE));

    const second = await postSolver(
      base,
      endpoint,
      solverBodyForModel(MODEL),
      'e2e-api-2'
    );
    assert.equal(second.status, 200);
    assert.match(await second.text(), /interaction\.completed/);

    const assertions = await fetch(
      base +
        '/__harness__/assertions?scenario=sse-error-next-profile&run=' +
        run
    ).then(item => item.json());
    assert.equal(assertions.ok, true);
    assert.deepEqual(assertions.scenarioChecks, {
      singleLineSseErrorWasSurfaced: true,
      advancedToNextOrderedTuple: true,
      noSyncDuplicateForSseError: true
    });
    assert.equal(assertions.counts.solverRequests, 2);
  });
});

test('marked gateway 200 SSE transport error stops without sync, another slot, or local fallback', async () => {
  await withServer(async (base, harness) => {
    const scenario = 'gateway-sse-transport-error-no-fallback';
    const run = 'gateway-sse-502-unavailable';
    const response = await fetch(
      base +
        '/__mock/gateway/v1/interactions?alt=sse' +
        '&scenario=' + scenario + '&run=' + run,
      {
        method: 'POST',
        headers: {
          Accept: 'text/event-stream',
          'Content-Type': 'application/json',
          'X-Math-Api-Slot': '1'
        },
        body: JSON.stringify({
          input: validSolverBody.input,
          stream: true
        })
      }
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-math-gateway'), '1');
    const wire = await response.text();
    const dataLines = wire
      .split(/\r?\n/)
      .filter(line => line.startsWith('data: '));
    assert.equal(dataLines.length, 1);
    const event = JSON.parse(dataLines[0].slice(6));
    assert.equal(event.event_type, 'error');
    assert.equal(event.error.code, 502);
    assert.equal(event.error.status, 'UNAVAILABLE');

    const assertions = await fetch(
      base + '/__harness__/assertions?scenario=' + scenario + '&run=' + run
    ).then(item => item.json());
    assert.equal(assertions.ok, true);
    assert.deepEqual(assertions.scenarioChecks, {
      receivedMarkedGatewaySseTransportError: true,
      exactlyOneGatewayPost: true,
      zeroSyncRecovery: true,
      zeroOtherGatewaySlot: true,
      zeroLocalFallback: true
    });
    assert.equal(assertions.counts.solverRequests, 1);
    assert.equal(assertions.counts.gatewayRequests, 1);
    assert.equal(assertions.counts.localRequests, 0);
    assert.equal(
      harness.requestLog.some(record =>
        record.run === run && record.body?.stream === false
      ),
      false
    );
  });
});

test('failed interaction completion advances without a sync duplicate', async () => {
  await withServer(async (base, harness) => {
    const run = 'terminal-failed-modality';
    const endpoint =
      '/__mock/gemini/v1beta/interactions?alt=sse' +
      '&scenario=terminal-failed-next-profile&run=' + run;
    const first = await postSolver(
      base,
      endpoint,
      solverBodyForModel(MODEL),
      'e2e-api-1'
    );
    assert.equal(first.status, 200);
    const wire = await first.text();
    const firstDataLine = wire
      .split(/\r?\n/)
      .find(line => line.startsWith('data: {'));
    assert.ok(firstDataLine);
    const terminalEvent = JSON.parse(firstDataLine.slice(5).trim());
    assert.equal(terminalEvent.event_type, 'interaction.completed');
    assert.equal(terminalEvent.interaction.status, 'failed');
    assert.equal(
      terminalEvent.interaction.errors[0].message,
      IMAGE_MODALITY_MESSAGE
    );

    const second = await postSolver(
      base,
      endpoint,
      solverBodyForModel(MODEL),
      'e2e-api-2'
    );
    assert.equal(second.status, 200);
    assert.match(await second.text(), /interaction\.completed/);

    const assertions = await fetch(
      base +
        '/__harness__/assertions?scenario=terminal-failed-next-profile&run=' +
        run
    ).then(item => item.json());
    assert.equal(assertions.ok, true);
    assert.deepEqual(assertions.scenarioChecks, {
      failedCompletionErrorsWereSurfaced: true,
      failedCompletionAdvancedDirectly: true,
      zeroSyncDuplicatesOnFailedTuple: true
    });
    assert.equal(assertions.counts.solverRequests, 2);
    assert.equal(
      harness.requestLog
        .filter(record => record.run === run)
        .some(record => record.body?.stream === false),
      false
    );
  });
});

test('thinking-only high demand reaches the fourth 3.6 tuple', async () => {
  await withServer(async base => {
    const run = 'thinking-only-high-demand';
    const endpoint =
      '/__mock/gemini/v1beta/interactions?alt=sse' +
      '&scenario=thought-high-demand-four&run=' + run;
    const expectedOrder = EXPECTED_FOUR_PROFILE_ORDER;

    for (let index = 0; index < expectedOrder.length; index++) {
      const [apiKey, model] = expectedOrder[index];
      const response = await postSolver(
        base,
        endpoint,
        solverBodyForModel(model),
        apiKey
      );
      assert.equal(response.status, 200);
      const wire = await response.text();

      if (index < 3) {
        const thoughtIndex = wire.indexOf('"type":"thought_summary"');
        const failureIndex = index % 2 === 0
          ? wire.indexOf('"event_type":"error"')
          : wire.indexOf('"status":"failed"');
        assert.ok(thoughtIndex >= 0);
        assert.ok(failureIndex > thoughtIndex);
        assert.equal(wire.includes('"type":"model_output"'), false);
        assert.match(wire, /currently experiencing high demand/i);
      } else {
        assert.match(wire, /interaction\.completed/);
        assert.match(wire, /model_output/);
      }
    }

    const assertions = await fetch(
      base +
        '/__harness__/assertions?scenario=thought-high-demand-four&run=' +
        run
    ).then(item => item.json());
    assert.equal(assertions.ok, true);
    assert.deepEqual(assertions.scenarioChecks, {
      exactThoughtHighDemandFallbackOrder: true,
      allFailedTuplesHadThoughtButNoAnswer: true,
      streamAndTerminalDemandErrorsWereHandled: true,
      fourthTupleCompleted: true,
      noSyncDuplicateDuringDemandFallback: true
    });
    assert.equal(assertions.counts.solverRequests, 4);
  });
});

test('high demand after answer output stops without profile fallback', async () => {
  await withServer(async base => {
    const run = 'answer-high-demand-guard';
    const endpoint =
      '/__mock/gemini/v1beta/interactions?alt=sse' +
      '&scenario=answer-high-demand-no-fallback&run=' + run;
    const response = await postSolver(
      base,
      endpoint,
      solverBodyForModel(MODEL),
      'e2e-api-1'
    );
    assert.equal(response.status, 200);
    const wire = await response.text();
    const thoughtIndex = wire.indexOf('"type":"thought_summary"');
    const answerIndex = wire.indexOf('"type":"model_output"');
    const failureIndex = wire.indexOf('"event_type":"error"');
    assert.ok(thoughtIndex >= 0);
    assert.ok(answerIndex > thoughtIndex);
    assert.ok(failureIndex > answerIndex);
    assert.ok(wire.includes(HIGH_DEMAND_MESSAGE));

    const assertionsUrl =
      base +
      '/__harness__/assertions?scenario=answer-high-demand-no-fallback&run=' +
      run;
    const assertions = await fetch(assertionsUrl).then(item => item.json());
    assert.equal(assertions.ok, true);
    assert.deepEqual(assertions.scenarioChecks, {
      answerThenHighDemandWasDelivered: true,
      answerThenHighDemandStoppedImmediately: true
    });
    assert.equal(assertions.counts.solverRequests, 1);

    const forbiddenSecond = await postSolver(
      base,
      endpoint,
      solverBodyForModel(MODEL),
      'e2e-api-2'
    );
    assert.equal(forbiddenSecond.status, 409);
    const afterForbidden = await fetch(assertionsUrl).then(item => item.json());
    assert.equal(afterForbidden.ok, false);
    assert.equal(
      afterForbidden.scenarioChecks.answerThenHighDemandStoppedImmediately,
      false
    );
  });
});

test('unsupported image format payload error never traverses profiles', async () => {
  await withServer(async base => {
    const run = 'unsupported-image-payload';
    const endpoint =
      '/__mock/gemini/v1beta/interactions?alt=sse' +
      '&scenario=payload-error-no-fallback&run=' + run;
    const first = await postSolver(
      base,
      endpoint,
      solverBodyForModel(MODEL),
      'e2e-api-1'
    );
    assert.equal(first.status, 200);
    assert.match(await first.text(), new RegExp(UNSUPPORTED_IMAGE_PAYLOAD_MESSAGE));

    const assertionsUrl =
      base +
      '/__harness__/assertions?scenario=payload-error-no-fallback&run=' +
      run;
    const assertions = await fetch(assertionsUrl).then(item => item.json());
    assert.equal(assertions.ok, true);
    assert.deepEqual(assertions.scenarioChecks, {
      payloadErrorWasSurfaced: true,
      payloadErrorStoppedImmediately: true
    });
    assert.equal(assertions.counts.solverRequests, 1);

    const forbiddenSecond = await postSolver(
      base,
      endpoint,
      solverBodyForModel(MODEL),
      'e2e-api-2'
    );
    assert.equal(forbiddenSecond.status, 409);
    const afterForbidden = await fetch(assertionsUrl).then(item => item.json());
    assert.equal(afterForbidden.ok, false);
    assert.equal(
      afterForbidden.scenarioChecks.payloadErrorStoppedImmediately,
      false
    );
  });
});

test('user Stop after partial output never continues to another profile', async () => {
  await withServer(async base => {
    const run = 'stop-no-continuation';
    const endpoint =
      '/__mock/gemini/v1beta/interactions?alt=sse' +
      '&scenario=slow&run=' + run;
    const controller = new AbortController();
    const response = await postSolver(
      base,
      endpoint,
      validSolverBody,
      'e2e-api-1',
      controller.signal
    );
    assert.equal(response.status, 200);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let received = '';
    while (!received.includes('Oduzmemo 3 sa obe strane')) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false);
      received += decoder.decode(chunk.value, { stream: true });
    }
    controller.abort();
    try { await reader.read(); } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 40));

    const assertions = await fetch(
      base +
        '/__harness__/assertions?scenario=slow&expectStop=1&run=' +
        run
    ).then(item => item.json());
    assert.equal(assertions.ok, true);
    assert.equal(assertions.scenarioChecks.clientAbortedSlowStream, true);
    assert.equal(assertions.scenarioChecks.stopDidNotContinueProfiles, true);
    assert.equal(assertions.counts.solverRequests, 1);
  });
});

test('transport failure after partial output never continues profiles', async () => {
  await withServer(async base => {
    const run = 'partial-no-continuation';
    const endpoint =
      '/__mock/gemini/v1beta/interactions?alt=sse' +
      '&scenario=partial-no-continue&run=' + run;
    const response = await postSolver(
      base,
      endpoint,
      validSolverBody,
      'e2e-api-1'
    );
    assert.equal(response.status, 200);
    await assert.rejects(response.text());
    await new Promise(resolve => setTimeout(resolve, 40));

    const assertionsUrl =
      base +
      '/__harness__/assertions?scenario=partial-no-continue&run=' +
      run;
    const assertions = await fetch(assertionsUrl).then(item => item.json());
    assert.equal(assertions.ok, true);
    assert.equal(assertions.scenarioChecks.partialOutputWasDelivered, true);
    assert.equal(
      assertions.scenarioChecks.partialOutputDidNotContinueProfiles,
      true
    );
    assert.equal(assertions.counts.solverRequests, 1);

    const unexpectedContinuation = await postSolver(
      base,
      endpoint,
      solverBodyForModel(MODEL),
      'e2e-api-2'
    );
    assert.equal(unexpectedContinuation.status, 409);
    const afterUnexpected = await fetch(assertionsUrl).then(item => item.json());
    assert.equal(afterUnexpected.ok, false);
    assert.equal(
      afterUnexpected.scenarioChecks.partialOutputDidNotContinueProfiles,
      false
    );
  });
});

test('reload retry reuses the saved prompt and exact real image once', async () => {
  await withServer(async base => {
    const run = 'retry-contract';
    const endpoint =
      '/__mock/gemini/v1beta/interactions?alt=sse' +
      '&scenario=retry-after-reload&run=' + run;
    const body = await retrySolverBody();

    const controller = new AbortController();
    const first = await postSolver(
      base,
      endpoint,
      body,
      'e2e-api-1',
      controller.signal
    );
    assert.equal(first.status, 200);
    controller.abort();
    await assert.rejects(first.text(), error => error?.name === 'AbortError');
    await new Promise(resolve => setTimeout(resolve, 30));

    await postRetryEvidence(
      base,
      run,
      retryEvidence('after-reload-pending-open')
    );
    await postRetryEvidence(
      base,
      run,
      retryEvidence('retry-request-started')
    );

    const retry = await postSolver(
      base,
      endpoint,
      body,
      'e2e-api-1'
    );
    assert.equal(retry.status, 200);
    assert.match(await retry.text(), /interaction\.completed/);

    await postRetryEvidence(
      base,
      run,
      retryEvidence('after-retry-completed', true)
    );
    await postRetryEvidence(
      base,
      run,
      retryEvidence('after-completed-empty-send', true)
    );

    const assertions = await fetch(
      base +
        '/__harness__/assertions?scenario=retry-after-reload&run=' +
        run
    ).then(item => item.json());

    assert.equal(assertions.ok, true);
    assert.deepEqual(assertions.scenarioChecks, {
      firstRequestAbortedForReload: true,
      savedUnansweredPromptSurvivedReload: true,
      savedRealImageSurvivedReload: true,
      retryPromptIsExact: true,
      retryImageIsByteExact: true,
      noDuplicateUserOnRetry: true,
      retryCompleted: true,
      completedAnswerIsNotResendable: true,
      noUnexpectedApi2: true
    });
    assert.equal(assertions.counts.solverRequests, 2);

    const unexpectedThird = await postSolver(
      base,
      endpoint,
      body,
      'e2e-api-1'
    );
    assert.equal(unexpectedThird.status, 200);
    await unexpectedThird.text();

    const afterThird = await fetch(
      base +
        '/__harness__/assertions?scenario=retry-after-reload&run=' +
        run
    ).then(item => item.json());
    assert.equal(afterThird.ok, false);
    assert.equal(
      afterThird.scenarioChecks.completedAnswerIsNotResendable,
      false
    );
  });
});

test('reload retry oracle rejects changed prompt, image, or API 2', async () => {
  await withServer(async base => {
    const run = 'retry-negative';
    const endpoint =
      '/__mock/gemini/v1beta/interactions?alt=sse' +
      '&scenario=retry-after-reload&run=' + run;
    const body = await retrySolverBody();
    const controller = new AbortController();
    const first = await postSolver(
      base,
      endpoint,
      body,
      'e2e-api-1',
      controller.signal
    );
    controller.abort();
    await assert.rejects(first.text(), error => error?.name === 'AbortError');
    await new Promise(resolve => setTimeout(resolve, 30));

    const changed = {
      ...body,
      input: [
        {
          type: 'image',
          mime_type: 'image/png',
          data: Buffer.from('different image bytes').toString('base64'),
          resolution: 'high'
        },
        { type: 'text', text: RETRY_PROMPT + ' promenjeno' }
      ]
    };
    const retry = await postSolver(
      base,
      endpoint,
      changed,
      'e2e-api-1'
    );
    await retry.text();

    const api2 = await postSolver(
      base,
      endpoint,
      body,
      'e2e-api-2'
    );
    assert.equal(api2.status, 409);

    const assertions = await fetch(
      base +
        '/__harness__/assertions?scenario=retry-after-reload&run=' +
        run
    ).then(item => item.json());
    assert.equal(assertions.ok, false);
    assert.equal(assertions.scenarioChecks.retryPromptIsExact, false);
    assert.equal(assertions.scenarioChecks.retryImageIsByteExact, false);
    assert.equal(assertions.scenarioChecks.noUnexpectedApi2, false);
  });
});

test('browser local limiter admits ten fixed-clock calls and blocks the eleventh before upstream', async () => {
  await withServer(async (base, harness) => {
    const scenario = 'local-limiter-fixed-clock';
    const run = 'fixed-clock-local-limit';
    const fakeKey = 'e2e-local-api-1';
    const fixedNow = 1_787_496_000_000;
    const values = new Map([
      [
        'matematika_local_api_fallback_v1',
        JSON.stringify([
          { key: fakeKey },
          { key: fakeKey },
          { key: '' },
          { key: '' }
        ])
      ]
    ]);
    const localStorage = {
      getItem(key) {
        return values.has(key) ? values.get(key) : null;
      },
      setItem(key, value) {
        values.set(key, String(value));
      },
      removeItem(key) {
        values.delete(key);
      }
    };
    const lockNames = [];
    const navigator = {
      locks: {
        async request(name, _options, callback) {
          lockNames.push(name);
          return callback();
        }
      }
    };
    const FrozenDate = { now: () => fixedNow };

    // Execute the exact limiter implementation shipped in the frontend.
    // Date.now is frozen before this small runtime is initialized.
    const source = await readFile(
      new URL('../../src/math-app.html', import.meta.url),
      'utf8'
    );
    const limiterStart = source.indexOf('  function localApiBucketId(key) {');
    const limiterEnd = source.indexOf(
      '  function makeGatewayUnavailableError',
      limiterStart
    );
    assert.ok(limiterStart >= 0 && limiterEnd > limiterStart);
    const limiterSource = source.slice(limiterStart, limiterEnd);
    const createLimiterRuntime = new Function(
      'localStorage',
      'navigator',
      'Date',
      [
        'const LOCAL_RATE_STORAGE = "matematika_local_api_rate_v1";',
        'function throwIfUserStopped() {}',
        limiterSource,
        'return { localApiBucketId, reserveLocalApiAttempt };'
      ].join('\n')
    );
    const limiter = createLimiterRuntime(
      localStorage,
      navigator,
      FrozenDate
    );

    const localBody = {
      ...validSolverBody,
      stream: false,
      system_instruction:
        'Odgovaraj jasno, prirodno' + ' i pregledno'.repeat(120)
    };
    const profiles = [
      { transport: 'local', slot: 1, key: fakeKey },
      { transport: 'local', slot: 2, key: fakeKey }
    ];

    for (let index = 0; index < 10; index++) {
      const profile = profiles[index % profiles.length];
      await limiter.reserveLocalApiAttempt(profile);

      const response = await fetch(
        base +
          '/__mock/local/v1beta/interactions?scenario=' + scenario +
          '&run=' + run,
        {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'x-goog-api-key': profile.key
          },
          body: JSON.stringify(localBody)
        }
      );
      assert.equal(response.status, 200);
      await response.json();
    }

    await assert.rejects(
      limiter.reserveLocalApiAttempt(profiles[1]),
      error =>
        error?.status === 429 &&
        error?.code === 'local_slot_rate_limited' &&
        error?.retryAfterMs === 60_001
    );

    const localCalls = harness.requestLog.filter(record =>
      record.scenario === scenario &&
      record.run === run &&
      record.transport === 'local'
    );
    assert.equal(localCalls.length, 10);
    assert.equal(
      localCalls.every(record => record.apiKey === fakeKey),
      true
    );

    const bucket = limiter.localApiBucketId(fakeKey);
    const persisted = JSON.parse(
      values.get('matematika_local_api_rate_v1') || '{}'
    );
    assert.deepEqual(
      persisted[bucket],
      Array.from({ length: 10 }, () => fixedNow)
    );
    assert.equal(Object.keys(persisted).length, 1);
    assert.equal(lockNames.length, 11);
    assert.equal(
      lockNames.every(name => name === 'matematika-local-api-rate-v1'),
      true
    );
  });
});
