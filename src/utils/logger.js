const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
};

function formatTimestamp() {
  const now = new Date();
  return now.toISOString().replace('T', ' ').substring(0, 19);
}

const logger = {
  info: (msg, ...args) => {
    console.log(`${colors.dim}[${formatTimestamp()}]${colors.reset} ${colors.cyan}[INFO]${colors.reset} ${msg}`, ...args);
  },
  success: (msg, ...args) => {
    console.log(`${colors.dim}[${formatTimestamp()}]${colors.reset} ${colors.green}[SUCCESS]${colors.reset} ${msg}`, ...args);
  },
  warn: (msg, ...args) => {
    console.warn(`${colors.dim}[${formatTimestamp()}]${colors.reset} ${colors.yellow}[WARN]${colors.reset} ${msg}`, ...args);
  },
  error: (msg, ...args) => {
    console.error(`${colors.dim}[${formatTimestamp()}]${colors.reset} ${colors.red}[ERROR]${colors.reset} ${msg}`, ...args);
  },
  music: (msg, ...args) => {
    console.log(`${colors.dim}[${formatTimestamp()}]${colors.reset} ${colors.magenta}[MUSIC]${colors.reset} ${msg}`, ...args);
  },
};

module.exports = logger;
