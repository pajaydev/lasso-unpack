const parseArgs = require('minimist');
const lassoUnpack = require('../lib/lasso-unpack');

const argv = parseArgs(process.argv.slice(2));

const input = argv._ || [];

if (input.length > 0) {
    input.map((fileName) => {
        lassoUnpack(fileName);
    });
} else {
    console.log("No input provided\nUsage: lasso-unpack < bundle.js >");
    return process.exit(1);
}
