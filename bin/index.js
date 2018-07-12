const parseArgs = require('minimist');
const lassoUnpack = require('../lib/lasso-unpack');

if (!argv) {
    argv = process.argv.slice(2);
}
