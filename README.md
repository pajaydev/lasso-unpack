# lasso-unpack
plugin to create manifest from the bundle created by Lasso.

Usage
========

## install

```
npm install -g lasso-unpack

lasso-unpack <bundle file path>
````
or

```
npm install --save-dev lasso-unpack

const parseBundle = require('./lasso-unpack');
parseBundle('lib/build.js');

```

## Output

Output a `lasso-stats.json` file to the parent directory, you can check all the files and their sizes bundled by Lasso.


The lasso-stats.json will look like this : 

```json
{
    "type": "def",
    "fileName": "src/main",
    "packageName": "lasso-js-api",
    "content": "{\n    var add = require('/lasso-js-api$0.0.0/src/add'/*'./add'*/);\n    var jquery = require('/jquery$2.2.4/dist/jquery'/*'jquery'*/);\n    var Greeter = require('/lasso-js-api$0.0.0/src/Greeter.ts'/*'./Greeter.ts'*/);\n\n    jquery(function () {\n        $(document.body).append('2+2=' + add(2, 2));\n        //console.log(greeter);\n        var greeter = new Greeter(\"Ajaykumar\");\n        $(document.body).append(greeter.greet());\n    });\n\n}",
    "version": "0.0.0",
    "size": 538,
    "gzipSize": 120,
    "brotiSize": 122,
    "path": "/lasso-js-api$0.0.0/src/main"
  }
```
## Example
input and output example files provided here
https://github.com/ajay2507/lasso-unpack/tree/master/examples

## Issues
If you are facing any issues or have any improvements, you can create issue here
https://github.com/ajay2507/lasso-unpack/issues

## Problem

Developer should know what presents inside bundle created by Lasso. It should not be a black box. lasso-unpack solves this problem, it unpacks the bundle and shows all the files present in the bundle. It includes content and size of js. file.

License
========

MIT
