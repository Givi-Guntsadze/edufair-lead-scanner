const assert = require('node:assert/strict');
const fs = require('node:fs');

const EXPECTED_CAMPUS_CONFIG = {
  sommet: ['Glion', 'Les Roches', 'Ecole Ducasse', 'Invictus Education', 'Indian School of Hospitality', 'Undecided'],
  audencia: ['Paris', 'Nantes', 'Undecided'],
  ied: ['Milan', 'Rome', 'Florence', 'Turin', 'Accademia Aldo Galli - Como', 'Madrid', 'Barcelona', 'Bilbao', 'Undecided'],
  ieu: ['Madrid', 'Segovia', 'Undecided'],
  nicosia: ['Nicosia', 'Athens', 'Undecided'],
  seg: ['SHMS', 'Cesar Ritz', 'HIM Business School', 'Culinary Arts Academy', 'Undecided'],
  ucam: ['Murcia', 'online', 'Undecided'],
  gbsb: ['Barcelona', 'Madrid', 'Malta', 'Online', 'Undecided'],
  skema: ['Lille', 'Paris', 'Sophia Antipolis', 'Brazil', 'Canada', 'China', 'South Africa', 'UAE', 'USA', 'Undecided'],
  eubschool: ['Barcelona', 'Geneva', 'Munich', 'Undecided'],
  xamk: ['Kouvola', 'Kotka', 'Mikkeli', 'Savonlinna', 'Undecided'],
  bsbi: ['Berlin', 'Hamburg', 'Barcelona', 'Madrid', 'Paris', 'Undecided'],
  campspain: ['Vigo', 'Madrid', 'Undecided'],
  into: ['US', 'UK', 'Australia', 'Spain', 'UAE', 'Undecided'],
  gedu: ['US', 'UK', 'Ireland', 'UAE', 'Australia', 'Germany', 'Malta', 'France', 'Spain', 'Undecided'],
  burgsb: ['Dijon', 'Lyon', 'Undecided']
};

function extractCampusConfigSnippet(source, filename) {
  const declarationMarker = 'const CAMPUS_CONFIG = Object.freeze({';
  const endMarker = 'CAMPUS_CONFIG:END';
  const startIndex = source.indexOf(declarationMarker);
  const endIndex = source.indexOf(endMarker);
  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
    throw new Error(`CAMPUS_CONFIG declaration not found in ${filename}`);
  }
  return source.slice(startIndex, endIndex);
}

function normalizeForComparison(snippet) {
  return snippet
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .join('\n');
}

function evaluateCampusConfig(snippet) {
  return new Function(`${snippet}\nreturn CAMPUS_CONFIG;`)();
}

const codeSource = fs.readFileSync('Code.gs', 'utf8');
const indexHtml = fs.readFileSync('index.html', 'utf8');
const scriptStart = indexHtml.lastIndexOf('<script>');
const sourceStart = indexHtml.indexOf('>', scriptStart) + 1;
const sourceEnd = indexHtml.indexOf('</script>', sourceStart);
const indexSource = indexHtml.slice(sourceStart, sourceEnd);

const codeSnippet = extractCampusConfigSnippet(codeSource, 'Code.gs');
const indexSnippet = extractCampusConfigSnippet(indexSource, 'index.html');

{
  assert.equal(
    normalizeForComparison(codeSnippet),
    normalizeForComparison(indexSnippet),
    'CAMPUS_CONFIG in Code.gs and index.html must stay identical'
  );
}

{
  const codeConfig = evaluateCampusConfig(codeSnippet);
  const indexConfig = evaluateCampusConfig(indexSnippet);
  assert.deepEqual(codeConfig, indexConfig);
  assert.deepEqual(codeConfig, EXPECTED_CAMPUS_CONFIG);
}

{
  const config = evaluateCampusConfig(codeSnippet);
  for (const [participantId, options] of Object.entries(config)) {
    assert.ok(Array.isArray(options) && options.length > 1, `${participantId} must have more than one option`);
    assert.equal(options[options.length - 1], 'Undecided', `${participantId} must end with Undecided`);
    assert.equal(new Set(options).size, options.length, `${participantId} must not have duplicate options`);
  }
}

{
  // Newly added institutions must resolve to exactly the expected options,
  // in the exact order, with no stray whitespace in any entry.
  const config = evaluateCampusConfig(codeSnippet);

  assert.deepEqual(
    config.into,
    ['US', 'UK', 'Australia', 'Spain', 'UAE', 'Undecided'],
    'into must resolve to exactly the six expected options in order'
  );
  assert.deepEqual(
    config.gedu,
    ['US', 'UK', 'Ireland', 'UAE', 'Australia', 'Germany', 'Malta', 'France', 'Spain', 'Undecided'],
    'gedu must resolve to exactly the ten expected options in order'
  );
  assert.deepEqual(
    config.burgsb,
    ['Dijon', 'Lyon', 'Undecided'],
    'burgsb must resolve to exactly the three expected options in order'
  );

  for (const participantId of ['into', 'gedu', 'burgsb']) {
    for (const option of config[participantId]) {
      assert.equal(option, option.trim(), `${participantId} option "${option}" must not have stray whitespace`);
    }
  }
}

console.log('Campus configuration parity tests passed');
