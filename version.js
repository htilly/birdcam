'use strict';

// Single source of truth for "which build is running".
//
//   version     – semantic version from package.json (bump with `npm version patch|minor|major`)
//   buildNumber – CI run number (GitHub Actions run_number, passed as BUILD_NUMBER build-arg)
//   gitCommit   – short commit hash (GIT_COMMIT build-arg, or `git rev-parse` in local dev)
//   buildTime   – when the image was built (BUILD_DATE build-arg), else process start time
//
// Display string: "v1.2.3 (#45 · abc1234)" – parts that are unknown are left out.

const path = require('path');
const { execSync } = require('child_process');

const pkg = require(path.join(__dirname, 'package.json'));

function clean(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s && s !== 'unknown' ? s : null;
}

function detectGitCommit(env = process.env) {
  let commit = clean(env.GIT_COMMIT);
  if (!commit) {
    try {
      commit = execSync('git rev-parse --short HEAD', {
        encoding: 'utf8',
        cwd: __dirname,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch (e) {
      commit = null;
    }
  }
  if (commit && !/^[0-9a-f]{4,40}$/i.test(commit)) return null;
  return commit ? commit.slice(0, 7) : null;
}

function buildInfo(env = process.env, now = new Date()) {
  const version = clean(pkg.version);
  const buildNumberRaw = clean(env.BUILD_NUMBER);
  const buildNumber = buildNumberRaw && /^\d+$/.test(buildNumberRaw) ? buildNumberRaw : null;
  const gitCommit = detectGitCommit(env);

  let buildTime = now.toISOString();
  const buildDate = clean(env.BUILD_DATE);
  if (buildDate && !Number.isNaN(Date.parse(buildDate))) {
    buildTime = new Date(buildDate).toISOString();
  }

  return { version, buildNumber, gitCommit, buildTime, display: formatVersion({ version, buildNumber, gitCommit }) };
}

function formatVersion({ version, buildNumber, gitCommit }) {
  const extras = [buildNumber ? '#' + buildNumber : null, gitCommit].filter(Boolean);
  const base = version ? 'v' + version : '';
  if (!extras.length) return base;
  return base ? `${base} (${extras.join(' · ')})` : extras.join(' · ');
}

const BUILD_INFO = Object.freeze(buildInfo());

module.exports = { BUILD_INFO, buildInfo, formatVersion };
