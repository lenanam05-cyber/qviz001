const express = require('express');
const multer = require('multer');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const app = express();
const upload = multer({ dest: os.tmpdir() });

const FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';

// ---- Canvas ----
const W = 900;
const H = 1600;
const FPS = 30;

// ---- Colors ----
const BROWN = '0x5A3210';
const GREEN = '0x1E7A1E';
const BORDER = 'white';

// ---- Font sizes (reduced ~15%) ----
const QUESTION_FONT = 40; // was 46
const HOOK_FONT = 40;     // was 46
const ANSWER_FONT = 34;   // was 40

// ---- Layout ----
const QUESTION_CY = 352;              // center Y of scroll / question zone
const ANSWER_CY = [581, 687, 789];    // center Y of the 3 answer boxes
const SIDE_MARGIN = 70;               // left/right padding for wrapping
const QUESTION_WRAP = 24;             // max chars per line for question/hook
const ANSWER_WRAP = 22;               // max chars per line for an answer

app.get('/health', (req, res) => res.json({ ok: true }));

// Escape text for ffmpeg drawtext text= value
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, '\u2019')  // curly apostrophe avoids quoting issues
    .replace(/%/g, '\\%')
    .replace(/\r?\n/g, ' ');
}

// Greedy word-wrap into lines of <= maxChars
function wrap(text, maxChars) {
  const words = String(text == null ? '' : text).trim().split(/\s+/);
  const lines = [];
  let cur = '';
  for (const w of words) {
    if (!cur) { cur = w; continue; }
    if ((cur + ' ' + w).length <= maxChars) { cur += ' ' + w; }
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}

// Build one drawtext filter segment (no input/output labels)
function drawtext({ text, fontsize, color, cy, enable }) {
  const lineH = Math.round(fontsize * 1.28);
  const lines = Array.isArray(text) ? text : [text];
  const n = lines.length;
  const startY = Math.round(cy - (n * lineH) / 2 + lineH / 2);
  return lines.map((ln, i) => {
    const y = startY + i * lineH - Math.round(fontsize / 2);
    return [
      'drawtext=fontfile=' + FONT,
      "text='" + esc(ln) + "'",
      'fontsize=' + fontsize,
      'fontcolor=' + color,
      'borderw=3',
      'bordercolor=' + BORDER,
      'x=(w-text_w)/2',
      'y=' + y,
      "enable='" + enable + "'",
    ].join(':');
  });
}

app.post(
  '/render',
  upload.fields([
    { name: 'fon', maxCount: 1 },
    { name: 'topleft', maxCount: 1 },
    { name: 'inscription', maxCount: 1 },
    { name: 'animal', maxCount: 1 },
    { name: 'item', maxCount: 1 },
    { name: 'transport', maxCount: 1 },
  ]),
  (req, res) => {
    let payload = {};
    try { payload = JSON.parse(req.body.payload || '{}'); }
    catch (e) { return res.status(400).json({ error: 'BAD_PAYLOAD', detail: String(e) }); }

    const f = req.files || {};
    const need = ['fon', 'topleft', 'inscription', 'animal', 'item', 'transport'];
    for (const k of need) {
      if (!f[k] || !f[k][0]) return res.status(400).json({ error: 'MISSING_FILE', field: k });
    }

    const t = payload.timings || {};
    const duration = Number(payload.duration) || Number(t.duration) || 13;
    const hookStart = Number(t.hook_start != null ? t.hook_start : 0);
    const questionStart = Number(t.question_start != null ? t.question_start : 3);
    const answerStart = Number(t.answer_start != null ? t.answer_start : 4);
    const answerStep = Number(t.answer_step != null ? t.answer_step : 0.3);
    const revealStart = Number(t.reveal_start != null ? t.reveal_start : 9);

    const question = payload.question || '';
    const hook = payload.hook || '';
    const answers = Array.isArray(payload.answers) ? payload.answers : [];
    const correctIndex = (Number(payload.correct_answer_position) || 1) - 1;

    const outPath = path.join(os.tmpdir(), 'out_' + Date.now() + '.mp4');

    // ---- Build filter_complex ----
    const segs = [];
    // Base: scale fon, then overlay 5 PNG layers (full-frame 900x1600 transparent)
    segs.push('[0:v]scale=' + W + ':' + H + ',setsar=1,fps=' + FPS + '[b]');
    segs.push('[b][1:v]overlay=0:0[o1]');
    segs.push('[o1][2:v]overlay=0:0[o2]');
    segs.push('[o2][3:v]overlay=0:0[o3]');
    segs.push('[o3][4:v]overlay=0:0[o4]');
    segs.push('[o4][5:v]overlay=0:0[o5]');

    // Collect drawtext filters
    const draws = [];

    // Hook: shown from hookStart until questionStart, in the scroll/question zone
    if (hook) {
      draws.push(...drawtext({
        text: wrap(hook, QUESTION_WRAP),
        fontsize: HOOK_FONT,
        color: BROWN,
        cy: QUESTION_CY,
        enable: 'between(t,' + hookStart + ',' + questionStart + ')',
      }));
    }

    // Question: from questionStart to end
    if (question) {
      draws.push(...drawtext({
        text: wrap(question, QUESTION_WRAP),
        fontsize: QUESTION_FONT,
        color: BROWN,
        cy: QUESTION_CY,
        enable: 'gte(t,' + questionStart + ')',
      }));
    }

    // Answers
    for (let i = 0; i < 3; i++) {
      const ans = answers[i];
      if (ans == null) continue;
      const appear = answerStart + i * answerStep;
      const cy = ANSWER_CY[i] != null ? ANSWER_CY[i] : (581 + i * 106);
      const wrapped = wrap(ans, ANSWER_WRAP);

      if (i === correctIndex) {
        // brown until reveal, then green
        draws.push(...drawtext({
          text: wrapped, fontsize: ANSWER_FONT, color: BROWN, cy,
          enable: 'between(t,' + appear + ',' + revealStart + ')',
        }));
        draws.push(...drawtext({
          text: wrapped, fontsize: ANSWER_FONT, color: GREEN, cy,
          enable: 'gte(t,' + revealStart + ')',
        }));
      } else {
        // wrong answers vanish at reveal
        draws.push(...drawtext({
          text: wrapped, fontsize: ANSWER_FONT, color: BROWN, cy,
          enable: 'between(t,' + appear + ',' + revealStart + ')',
        }));
      }
    }

    // Chain drawtext filters after [o5]
    let prev = 'o5';
    draws.forEach((d, idx) => {
      const out = 'd' + idx;
      segs.push('[' + prev + ']' + d + '[' + out + ']');
      prev = out;
    });
    // Ensure a final video label even if no drawtext
    if (draws.length === 0) {
      segs.push('[o5]null[vout]');
      prev = 'vout';
    } else {
      // rename last label to vout
      segs[segs.length - 1] = segs[segs.length - 1].replace('[' + prev + ']', '[vout]');
      prev = 'vout';
    }

    const filterComplex = segs.join(';');

    const args = [
      '-y',
      '-i', f.fon[0].path,
      '-i', f.topleft[0].path,
      '-i', f.inscription[0].path,
      '-i', f.animal[0].path,
      '-i', f.item[0].path,
      '-i', f.transport[0].path,
      '-filter_complex', filterComplex,
      '-map', '[vout]',
      '-map', '0:a?',
      '-t', String(duration),          // hard cap output length = payload.duration (13)
      '-r', String(FPS),
      '-pix_fmt', 'yuv420p',
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-threads', '2',
      '-filter_complex_threads', '1',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-movflags', '+faststart',
      outPath,
    ];

    const ff = spawn('ffmpeg', args);
    let stderr = '';
    ff.stderr.on('data', (d) => { stderr += d.toString(); });

    ff.on('close', (code) => {
      if (code !== 0 || !fs.existsSync(outPath)) {
        console.error('FFMPEG FAILED code=' + code);
        console.error(stderr);            // real cause visible in Deploy Logs
        return res.status(500).json({
          error: 'FFMPEG_FAILED',
          exitCode: code,
          stderr: stderr.slice(-4000),
        });
      }
      res.setHeader('Content-Type', 'video/mp4');
      const stream = fs.createReadStream(outPath);
      stream.pipe(res);
      stream.on('close', () => { try { fs.unlinkSync(outPath); } catch (e) {} });
    });

    ff.on('error', (err) => {
      console.error('SPAWN ERROR', err);
      res.status(500).json({ error: 'SPAWN_ERROR', detail: String(err) });
    });
  }
);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Render server on ' + PORT));
