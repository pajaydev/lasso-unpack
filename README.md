# lasso-unpack
plugin to create manifest from the bundle created by Lasso.

Usage
========

## install

```
npm install --save-dev lasso-unpack

lasso-unpack <bundle file path>

```

## Output

Output a `lasso-stats.json` file to the parent directory.


The lasso-stats.json will look like this : 

```json
{
  "index.html": "/dist/index.html",
  "index.js": "/dist/5f0796534fe2892712053b3a035f585b.js",
  "main.scss": "/dist/5f0796534fe2892712053b3a035f585b.css"
}
```

## Problem

Developer should know what presents inside bundle created by Lasso. It should not be a black box. lasso-unpack solves this problem, it unpacks the bundle and shows all the files present in the bundle. It includes content and size of js file.

License
========

MIT
