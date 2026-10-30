import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const readSource = (path) => readFile(new URL(path, import.meta.url), 'utf8');

/** Extract the main card pan-responder block (not the scrub one in MemoryVideo). */
async function readMainPanResponder() {
  const card = await readSource('../src/components/MemoryCard.js');
  const start = card.indexOf('// ---- Swipe / pinch / pan responder (deletes, favorite, zoom) ----');
  const end = card.indexOf('// Tap / long-press detection');
  assert.ok(start >= 0 && end > start, 'main pan-responder block not found');
  return { card, block: card.slice(start, end) };
}

test('every gesture entry mutes audio synchronously (PRD 5.2 / 0ms rule)', async () => {
  const { card, block } = await readMainPanResponder();
  const home = await readSource('../src/screens/HomeScreen.js');

  // Grant entry: swipe / pinch / pan all route through onPanResponderGrant,
  // which must silence everyone BEFORE deciding the direction.
  const grant = block.split('onPanResponderGrant:')[1]?.split('onPanResponderMove:')[0];
  assert.ok(grant, 'grant handler missing');
  assert.match(grant, /silenceAllPlayers\(\)/);
  assert.match(grant, /gestureMuteRef\.current = true/);

  // Vertical paging entry (regression guard for the already-correct path).
  const beginDrag = home.split('onScrollBeginDrag=')[1]?.split('onScrollEndDrag=')[0];
  assert.ok(beginDrag, 'onScrollBeginDrag missing');
  assert.match(beginDrag, /silenceAllPlayers\(\)/);

  // Trash commit must cut audio synchronously, not via the setPlaying commit.
  const commitTrash = card.split('const commitTrash = ')[1]?.split('const commitFavRef = ')[0];
  assert.ok(commitTrash, 'commitTrash missing');
  assert.match(commitTrash, /silenceAllPlayers\(\);\s*setPlaying\(false\)/);
});

test('a gesture that ends without deleting resumes the current card audio', async () => {
  const { card, block } = await readMainPanResponder();

  // Resume is guarded: only the still-active, still-playing card resumes.
  assert.match(card, /if \(!activeRef\.current \|\| !playingRef\.current\) return;/);
  assert.match(card, /if \(player\) safePlayPlayer\(player\);/);

  // Favorite / snapback / pinch / pan all resume; trash must NOT resume.
  const release = block.split('onPanResponderRelease:')[1];
  assert.ok(release, 'release handler missing');
  const resumeCount = (release.match(/h\.resumeGestureAudio\(\)/g) || []).length;
  assert.ok(resumeCount >= 3, `expected resume on fav + snapback + pinch/pan, got ${resumeCount}`);
  const trashBranch = release.split('h.commitTrash();')[1]?.split('h.commitFav();')[0];
  assert.ok(trashBranch, 'trash branch missing');
  assert.doesNotMatch(trashBranch, /resumeGestureAudio/);

  // Interrupted gestures (system steal) resume too.
  const terminate = block.split('onPanResponderTerminate:')[1];
  assert.ok(terminate, 'terminate handler missing');
  assert.match(terminate, /h\.resumeGestureAudio\(\)/);
});

test('video error entry silences its player synchronously', async () => {
  const card = await readSource('../src/components/MemoryCard.js');
  assert.match(card, /if \(s === 'error'\) \{/);
  const errorBranch = card.split("if (s === 'error') {")[1]?.split('}')[0];
  assert.match(errorBranch, /silencePlayer\(player\);/);
  assert.match(errorBranch, /if \(playing\) onEnd\(\);/);
});

test('live photo players report upward so cancelled gestures can resume them', async () => {
  const card = await readSource('../src/components/MemoryCard.js');
  assert.match(card, /function LivePhotoVideo\(\{[^}]*onPlayerChange/);
  assert.match(card, /onPlayerChange=\{handleVideoPlayerChange\}/);
  // The card keeps a local player ref for the resume path.
  assert.match(card, /const cardPlayerRef = useRef\(null\);/);
  assert.match(card, /cardPlayerRef\.current = player \|\| null;/);
});
