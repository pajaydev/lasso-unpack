/*
GOAL: This module should mirror the NodeJS module system according the documented behavior.
The module transport will send down code that registers module definitions by an assigned path. In addition,
the module transport will send down code that registers additional metadata to allow the module resolver to
resolve modules in the browser. Additional metadata includes the following:

- "mains": The mapping of module directory paths to a fully resolved module path
- "remaps": The remapping of one fully resolved module path to another fully resolved module path (used for browser overrides)
- "run": A list of entry point modules that should be executed when ready

Inspired by:
https://github.com/joyent/node/blob/master/lib/module.js
*/
(function() {
    var win;

    if (typeof window !== 'undefined') {
        win = window;

        // This lasso modules client has already been loaded on the page. Do nothing;
        if (win.$_mod) {
            return;
        }

        win.global = win;
    }

    /** the module runtime */
    var $_mod;

    // this object stores the module factories with the keys being module paths and
    // values being a factory function or object (e.g. "/baz$3.0.0/lib/index" --> Function)
    var definitions = {};

    // Search path that will be checked when looking for modules
    var searchPaths = [];

    // The _ready flag is used to determine if "run" modules can
    // be executed or if they should be deferred until all dependencies
    // have been loaded
    var _ready = false;

    // If $_mod.run() is called when the page is not ready then
    // we queue up the run modules to be executed later
    var runQueue = [];

    // this object stores the Module instance cache with the keys being paths of modules (e.g., "/foo$1.0.0/bar" --> Module)
    var instanceCache = {};

    // This object maps installed dependencies to specific versions
    //
    // For example:
    // {
    //   // The package "foo" with version 1.0.0 has an installed package named "bar" (foo/node_modules/bar") and
    //   // the version of "bar" is 3.0.0
    //   "/foo$1.0.0/bar": "3.0.0"
    // }
    var installed = {};

    // Maps builtin modules such as "path", "buffer" to their fully resolved paths
    var builtins = {};

    // this object maps a directory to the fully resolved module path
    //
    // For example:
    //
    var mains = {};

    // used to remap a one fully resolved module path to another fully resolved module path
    var remapped = {};

    var cacheByDirname = {};

    // When a module is mapped to a global varialble we add a reference
    // that maps the path of the module to the loaded global instance.
    // We use this mapping to ensure that global modules are only loaded
    // once if they map to the same path.
    //
    // See issue #5 - Ensure modules mapped to globals only load once
    // https://github.com/raptorjs/raptor-modules/issues/5
    var loadedGlobalsByRealPath = {};

    function moduleNotFoundError(target, from) {
        var err = new Error('Cannot find module "' + target + '"' + (from ? ' from "' + from + '"' : ''));

        err.code = 'MODULE_NOT_FOUND';
        return err;
    }

    function Module(filename) {
       /*
        A Node module has these properties:
        - filename: The path of the module
        - id: The path of the module (same as filename)
        - exports: The exports provided during load
        - loaded: Has module been fully loaded (set to false until factory function returns)

        NOT SUPPORTED:
        - parent: parent Module
        - paths: The search path used by this module (NOTE: not documented in Node.js module system so we don't need support)
        - children: The modules that were required by this module
        */
        this.id = this.filename = filename;
        this.loaded = false;
        this.exports = undefined;
    }

    Module.cache = instanceCache;

    // temporary variable for referencing the Module prototype
    var Module_prototype = Module.prototype;

    Module_prototype.load = function(factoryOrObject) {
        var filename = this.id;

        if (factoryOrObject && factoryOrObject.constructor === Function) {
            // factoryOrObject is definitely a function
            var lastSlashPos = filename.lastIndexOf('/');

            // find the value for the __dirname parameter to factory
            var dirname = filename.substring(0, lastSlashPos);

            // local cache for requires initiated from this module/dirname
            var localCache = cacheByDirname[dirname] || (cacheByDirname[dirname] = {});

            // this is the require used by the module
            var instanceRequire = function(target) {
                // Only store the `module` in the local cache since `module.exports` may not be accurate
                // if there was a circular dependency
                var module = localCache[target] || (localCache[target] = requireModule(target, dirname));
                return module.exports;
            };

            // The require method should have a resolve method that will return the resolved
            // path but not actually instantiate the module.
            // This resolve function will make sure a definition exists for the corresponding
            // path of the target but it will not instantiate a new instance of the target.
            instanceRequire.resolve = function(target) {
                if (!target) {
                    throw moduleNotFoundError('');
                }

                var resolved = resolve(target, dirname);

                if (!resolved) {
                    throw moduleNotFoundError(target, dirname);
                }

                // NOTE: resolved[0] is the path and resolved[1] is the module factory
                return resolved[0];
            };

            // NodeJS provides access to the cache as a property of the "require" function
            instanceRequire.cache = instanceCache;

            // Expose the module system runtime via the `runtime` property
            // TODO: We should deprecate this in favor of `Module.prototype.__runtime`
            // @deprecated
            instanceRequire.runtime = $_mod;

            // $_mod.def("/foo$1.0.0/lib/index", function(require, exports, module, __filename, __dirname) {
            this.exports = {};

            // call the factory function
            factoryOrObject.call(this, instanceRequire, this.exports, this, filename, dirname);
        } else {
            // factoryOrObject is not a function so have exports reference factoryOrObject
            this.exports = factoryOrObject;
        }

        this.loaded = true;
    };

    /**
     * Defines a packages whose metadata is used by raptor-loader to load the package.
     */
    function define(path, factoryOrObject, options) {
        /*
        $_mod.def('/baz$3.0.0/lib/index', function(require, exports, module, __filename, __dirname) {
            // module source code goes here
        });
        */

        var globals = options && options.globals;

        definitions[path] = factoryOrObject;

        if (globals) {
            var target = win || global;
            for (var i=0;i<globals.length; i++) {
                var globalVarName = globals[i];
                var globalModule = loadedGlobalsByRealPath[path] = requireModule(path);
                target[globalVarName] = globalModule.exports;
            }
        }
    }

    function registerMain(path, relativePath) {
        mains[path] = relativePath;
    }

    function remap(fromPath, toPath) {
        remapped[fromPath] = toPath;
    }

    function builtin(name, target) {
        builtins[name] = target;
    }

    function registerInstalledDependency(parentPath, packageName, packageVersion) {
        // Example:
        // dependencies['/my-package$1.0.0/$/my-installed-package'] = '2.0.0'
        installed[parentPath + '/' + packageName] =  packageVersion;
    }

    /**
     * This function will take an array of path parts and normalize them by handling handle ".." and "."
     * and then joining the resultant string.
     *
     * @param {Array} parts an array of parts that presumedly was split on the "/" character.
     */
    function normalizePathParts(parts) {

        // IMPORTANT: It is assumed that parts[0] === "" because this method is used to
        // join an absolute path to a relative path
        var i;
        var len = 0;

        var numParts = parts.length;

        for (i = 0; i < numParts; i++) {
            var part = parts[i];

            if (part === '.') {
                // ignore parts with just "."
                /*
                // if the "." is at end of parts (e.g. ["a", "b", "."]) then trim it off
                if (i === numParts - 1) {
                    //len--;
                }
                */
            } else if (part === '..') {
                // overwrite the previous item by decrementing length
                len--;
            } else {
                // add this part to result and increment length
                parts[len] = part;
                len++;
            }
        }

        if (len === 1) {
            // if we end up with just one part that is empty string
            // (which can happen if input is ["", "."]) then return
            // string with just the leading slash
            return '/';
        } else if (len > 2) {
            // parts i s
            // ["", "a", ""]
            // ["", "a", "b", ""]
            if (parts[len - 1].length === 0) {
                // last part is an empty string which would result in trailing slash
                len--;
            }
        }

        // truncate parts to remove unused
        parts.length = len;
        return parts.join('/');
    }

    function join(from, target) {
        var targetParts = target.split('/');
        var fromParts = from == '/' ? [''] : from.split('/');
        return normalizePathParts(fromParts.concat(targetParts));
    }

    function withoutExtension(path) {
        var lastDotPos = path.lastIndexOf('.');
        var lastSlashPos;

        /* jshint laxbreak:true */
        return ((lastDotPos === -1) || ((lastSlashPos = path.lastIndexOf('/')) !== -1) && (lastSlashPos > lastDotPos))
            ? null // use null to indicate that returned path is same as given path
            : path.substring(0, lastDotPos);
    }

    function splitPackageIdAndSubpath(path) {
        path = path.substring(1); /* Skip past the first slash */
        // Examples:
        //     '/my-package$1.0.0/foo/bar' --> ['my-package$1.0.0', '/foo/bar']
        //     '/my-package$1.0.0' --> ['my-package$1.0.0', '']
        //     '/my-package$1.0.0/' --> ['my-package$1.0.0', '/']
        //     '/@my-scoped-package/foo/$1.0.0/' --> ['@my-scoped-package/foo$1.0.0', '/']
        var slashPos = path.indexOf('/');

        if (path.charAt(1) === '@') {
            // path is something like "/@my-user-name/my-scoped-package/subpath"
            // For scoped packages, the package name is two parts. We need to skip
            // past the second slash to get the full package name
            slashPos = path.indexOf('/', slashPos+1);
        }

        var packageIdEnd = slashPos === -1 ? path.length : slashPos;

        return [
            path.substring(0, packageIdEnd), // Everything up to the slash
            path.substring(packageIdEnd) // Everything after the package ID
        ];
    }

    function resolveInstalledModule(target, from) {
        // Examples:
        // target='foo', from='/my-package$1.0.0/hello/world'

        if (target.charAt(target.length-1) === '/') {
            // This is a hack because I found require('util/') in the wild and
            // it did not work because of the trailing slash
            target = target.slice(0, -1);
        }

        // Check to see if the target module is a builtin module.
        // For example:
        // builtins['path'] = '/path-browserify$0.0.0/index'
        var builtinPath = builtins[target];
        if (builtinPath) {
            return builtinPath;
        }

        var fromParts = splitPackageIdAndSubpath(from);
        var fromPackageId = fromParts[0];


        var targetSlashPos = target.indexOf('/');
        var targetPackageName;
        var targetSubpath;

        if (targetSlashPos < 0) {
            targetPackageName = target;
            targetSubpath = '';
        } else {

            if (target.charAt(0) === '@') {
                // target is something like "@my-user-name/my-scoped-package/subpath"
                // For scoped packages, the package name is two parts. We need to skip
                // past the first slash to get the full package name
                targetSlashPos = target.indexOf('/', targetSlashPos + 1);
            }

            targetPackageName = target.substring(0, targetSlashPos);
            targetSubpath = target.substring(targetSlashPos);
        }

        var targetPackageVersion = installed[fromPackageId + '/' + targetPackageName];
        if (targetPackageVersion) {
            var resolvedPath = '/' + targetPackageName + '$' + targetPackageVersion;
            if (targetSubpath) {
                resolvedPath += targetSubpath;
            }
            return resolvedPath;
        }
    }

    function resolve(target, from) {
        var resolvedPath;

        if (target.charAt(0) === '.') {
            // turn relative path into absolute path
            resolvedPath = join(from, target);
        } else if (target.charAt(0) === '/') {
            // handle targets such as "/my/file" or "/$/foo/$/baz"
            resolvedPath = normalizePathParts(target.split('/'));
        } else {
            var len = searchPaths.length;
            for (var i = 0; i < len; i++) {
                // search path entries always end in "/";
                var candidate = searchPaths[i] + target;
                var resolved = resolve(candidate, from);
                if (resolved) {
                    return resolved;
                }
            }

            resolvedPath = resolveInstalledModule(target, from);
        }

        if (!resolvedPath) {
            return undefined;
        }

        // target is something like "/foo/baz"
        // There is no installed module in the path
        var relativePath;

        // check to see if "target" is a "directory" which has a registered main file
        if ((relativePath = mains[resolvedPath]) !== undefined) {
            if (!relativePath) {
                relativePath = 'index';
            }

            // there is a main file corresponding to the given target so add the relative path
            resolvedPath = join(resolvedPath, relativePath);
        }

        var remappedPath = remapped[resolvedPath];
        if (remappedPath) {
            resolvedPath = remappedPath;
        }

        var factoryOrObject = definitions[resolvedPath];
        if (factoryOrObject === undefined) {
            // check for definition for given path but without extension
            var resolvedPathWithoutExtension;
            if (((resolvedPathWithoutExtension = withoutExtension(resolvedPath)) === null) ||
                ((factoryOrObject = definitions[resolvedPathWithoutExtension]) === undefined)) {
                return undefined;
            }

            // we found the definition based on the path without extension so
            // update the path
            resolvedPath = resolvedPathWithoutExtension;
        }

        return [resolvedPath, factoryOrObject];
    }

    function requireModule(target, from) {
        if (!target) {
            throw moduleNotFoundError('');
        }

        var resolved = resolve(target, from);
        if (!resolved) {
            throw moduleNotFoundError(target, from);
        }

        var resolvedPath = resolved[0];

        var module = instanceCache[resolvedPath];

        if (module !== undefined) {
            // found cached entry based on the path
            return module;
        }

        // Fixes issue #5 - Ensure modules mapped to globals only load once
        // https://github.com/raptorjs/raptor-modules/issues/5
        //
        // If a module is mapped to a global variable then we want to always
        // return that global instance of the module when it is being required
        // to avoid duplicate modules being loaded. For modules that are mapped
        // to global variables we also add an entry that maps the path
        // of the module to the global instance of the loaded module.

        if (loadedGlobalsByRealPath.hasOwnProperty(resolvedPath)) {
            return loadedGlobalsByRealPath[resolvedPath];
        }

        var factoryOrObject = resolved[1];

        module = new Module(resolvedPath);

        // cache the instance before loading (allows support for circular dependency with partial loading)
        instanceCache[resolvedPath] = module;

        module.load(factoryOrObject);

        return module;
    }

    function require(target, from) {
        var module = requireModule(target, from);
        return module.exports;
    }

    /*
    $_mod.run('/$/installed-module', '/src/foo');
    */
    function run(path, options) {
        var wait = !options || (options.wait !== false);
        if (wait && !_ready) {
            return runQueue.push([path, options]);
        }

        require(path, '/');
    }

    /*
     * Mark the page as being ready and execute any of the
     * run modules that were deferred
     */
    function ready() {
        _ready = true;

        var len;
        while((len = runQueue.length)) {
            // store a reference to the queue before we reset it
            var queue = runQueue;

            // clear out the queue
            runQueue = [];

            // run all of the current jobs
            for (var i = 0; i < len; i++) {
                var args = queue[i];
                run(args[0], args[1]);
            }

            // stop running jobs in the queue if we change to not ready
            if (!_ready) {
                break;
            }
        }
    }

    function addSearchPath(prefix) {
        searchPaths.push(prefix);
    }

    var pendingCount = 0;
    var onPendingComplete = function() {
        pendingCount--;
        if (!pendingCount) {
            // Trigger any "require-run" modules in the queue to run
            ready();
        }
    };

    /*
     * $_mod is the short-hand version that that the transport layer expects
     * to be in the browser window object
     */
    Module_prototype.__runtime = $_mod = {
        /**
         * Used to register a module factory/object (*internal*)
         */
        def: define,

        /**
         * Used to register an installed dependency (e.g. "/$/foo" depends on "baz") (*internal*)
         */
        installed: registerInstalledDependency,
        run: run,
        main: registerMain,
        remap: remap,
        builtin: builtin,
        require: require,
        resolve: resolve,
        join: join,
        ready: ready,

        /**
         * Add a search path entry (internal)
         */
        searchPath: addSearchPath,

        /**
         * Sets the loader metadata for this build.
         *
         * @param asyncPackageName {String} name of asynchronous package
         * @param contentType {String} content type ("js" or "css")
         * @param bundleUrl {String} URL of bundle that belongs to package
         */
        loaderMetadata: function(data) {
            // We store loader metadata in the prototype of Module
            // so that `lasso-loader` can read it from
            // `module.__loaderMetadata`.
            Module_prototype.__loaderMetadata = data;
        },

        /**
         * Asynchronous bundle loaders should call `pending()` to instantiate
         * a new job. The object we return here has a `done` method that
         * should be called when the job completes. When the number of
         * pending jobs drops to 0, we invoke any of the require-run modules
         * that have been declared.
         */
        pending: function() {
            _ready = false;
            pendingCount++;
            return {
                done: onPendingComplete
            };
        }
    };

    if (win) {
        win.$_mod = $_mod;
    } else {
        module.exports = $_mod;
    }
})();

$_mod.installed("site-speed-ebay$4.0.3", "cookies-browser", "0.0.2");
$_mod.main("/cookies-browser$0.0.2", "");
$_mod.def("/cookies-browser$0.0.2/index", function(require, exports, module, __filename, __dirname) { 
/**
* Reads and writes cookies for Marketplace domain page.
* <p>
* Note: This class is only used for eBay site.
*
*/

'use strict';

var DEFAULT_COOKIE_FORMAT = {
        "COOKIELET_DELIMITER":"^",
        "NAME_VALUE_DELIMITER":"/",
        "escapedValue":true
    },
    DP_COOKIE_FORMAT = { // FORMAT: delim-persist
        "COOKIELET_DELIMITER":"^",
        "NAME_VALUE_DELIMITER":"/",
        "bUseExp":true,
        "startDelim":"b"
    },
    SESSION_COOKIE_FORMAT = { // FORMAT: delimited
        "COOKIELET_DELIMITER":"^",
        "NAME_VALUE_DELIMITER":"=",
        "escapedValue":true,
        "startDelim":"^"
    },
    DS_COOKIE_FORMAT = { // FORMAT: delim-session
        "COOKIELET_DELIMITER":"^",
        "NAME_VALUE_DELIMITER":"/"
    },
    sPath = "/",
    aConversionMap = {
        'reg': ['dp1', 'reg'],
        'recent_vi': ['ebay', 'lvmn'],
        'ebaysignin': ['ebay', 'sin'],
        'p': ['dp1', 'p'],
        'etfc': ['dp1', 'etfc'],
        'keepmesignin': ['dp1', 'kms'],
        'ItemList': ['ebay', 'wl'],
        'BackToList': ['s', 'BIBO_BACK_TO_LIST']
    },
        aFormatMap = {
            'r': DEFAULT_COOKIE_FORMAT,
            'dp1': DP_COOKIE_FORMAT,
            'npii': DP_COOKIE_FORMAT,
            'ebay': SESSION_COOKIE_FORMAT,
            'reg': SESSION_COOKIE_FORMAT,
            'apcCookies': SESSION_COOKIE_FORMAT,
            'ds2': DS_COOKIE_FORMAT
        },
        sCOMPAT = "10",
        sCONVER = "01",
        sSTRICT = "00",

        sModesCookie = "ebay",
        sModesCookielet = "cv";

var api = {
    /**
    * Gets the value of the given cookielet from a specified cookie.
    *
    * @param {String} cookie
    *        a string name of the cookie
    * @param {String} cookielet
    *        a string name of the cookielet in the specified cookie
    * @return {String}
    *        the value of the cookielet
    */
    //>public String readCookie(String,String);
    readCookie: function(psCookie, psCookielet) {
        var rv = this.readCookieObj(psCookie, psCookielet).value;
        return (rv) ? decodeURIComponent(rv) : "";
    },

    //>private Object createDefaultCookieBean(String, String);
    createDefaultCookieBean: function(psCookie, psCookielet) {
        // define cookie bean
        var cookie = {};
        // string
        cookie.name = psCookie;
        // string
        cookie.cookieletname = psCookielet;
        // string
        cookie.value = "";
        // date in millisecs UTC
        cookie.maxage = 0;
        cookie.rawcookievalue = "";
        cookie.mode = "";
        return cookie;
    },

    // TODO make internal method to return cookie object readCookieObj
    //> private String readCookieObj(String,String);
    readCookieObj: function(psCookie, psCookielet) {
        var cookie = this.createDefaultCookieBean(psCookie, psCookielet);
        this.update();
        this.checkConversionMap(cookie);

        // returns the raw value of the cookie from document.cookie
        // raw value
        cookie.rawcookievalue = this.aCookies[cookie.name];

        // TODO - determine why this is required
        if (!cookie.name || !cookie.rawcookievalue) {
            cookie.value = "";
        }
        else if (!cookie.cookieletname) {
            // read cookie
            this.readCookieInternal(cookie);
        }
        else {
            // read cookielet
            this.readCookieletInternal(cookie);
        }

        // Check cookie corruption

        var guid = (psCookielet && psCookielet.match(/guid$/));
        var object = (typeof cookie !== 'undefined') ? cookie : '';

        var corrupted = (object && guid && (cookie.value.length > 32));
        if (corrupted) {
            cookie.value = cookie.value.substring(0, 32);
        }

        return object;

    },

    //> private void checkConversionMap(Object);
    checkConversionMap: function(cookie) {
        //Check conversion map
        // 2 values returned - 2 values cookie + cookielet
        var cmap = aConversionMap[cookie.name];

        // if cookielet is in conversio map then do the following
        // reset cookie and cookielet names to old namesl
        /*
                raw cookies are being converted to cookielets
                this takes care of the moving cookies to cookielets
        */

        if (cmap) {
            // compatibility mode
            cookie.mode = this.getMode(cookie.name);
            cookie.name = cmap[0];
            cookie.cookieletname = cmap[1];
        }
    },

    //> private Object readCookieInternal(Object);
    readCookieInternal: function(cookie) {
        // read raw cookie with compatibility modes to switch between raw cookie and cookielets
        cookie.value  = cookie.rawcookievalue;
        return cookie;
    },

    //> private Object readCookieletInternal(Object);
    readCookieletInternal: function(cookie) {
        var clet = this.getCookielet(cookie.name, cookie.cookieletname, cookie.rawcookievalue);
        // handling formats of cookielets mentiond in aFormatMap
        var format = this.getFormat(cookie.name);
        if (clet && format.bUseExp) {
            //do not expire cookie on client
            var cletOrig = clet;
            clet = clet.substring(0, clet.length - 8);
            if (cletOrig.length > 8) {
                cookie.maxage = cletOrig.substring(cletOrig.length - 8);
            }
        }

        // All other modes and if mode is not available
        cookie.value = clet;
        // COMPAT mode
        if (cookie.mode == sCOMPAT) { // jshint ignore:line
            cookie.value = cookie.rawcookievalue;
        }
        return cookie;
    },

    /**
    * Gets multiple values from a cookielet. This function splits a cookielet
    * value by predefined delimiter and construct an array stores each value.
    *
    * @param {String} cookie
    *        a string name of the cookie
    * @param {String} cookielet
    *        a string name of the cookielet in the specified cookie
    * @return {Object}
    *        an array that stores the multiples value
    */
    //> public Object readMultiLineCookie(String,String);
    readMultiLineCookie: function(psCookie, psCookielet) { // jshint ignore:line
        //this.update();
        if (!psCookie || !psCookielet) {
            return "";
        }
        var val, r = "";
        var cmap = aConversionMap[psCookie];
        if (cmap) {
            val = this.readCookieObj(cmap[0], cmap[1]).value || "";
        }
        if (val) {
            r = this.getCookielet(psCookie, psCookielet, val) || "";
        }
        return (typeof r !== "undefined") ? r : "";
    },

    /**
    * Writes a value String to a given cookie. This function requires setting
    * an exact expire date. You can use {@link writeCookieEx} instead to set
    * the days that the cookie will be avaliable.
    *
    * @param {String} cookie
    *        a string name of the cookie to be written
    * @param {String} value
    *        a string value to be written in cookie
    * @param {String} exp
    *        an exact expired date of the cookie
    * @see #writeCookieEx
    */
    //> public void writeCookie(String,String,String);
    //> public void writeCookie(String,String,int);
    writeCookie: function(psCookie, psVal, psExp) {
        //@param    pbSecure - secured? (optional)
        //Check conversion map
        var cmap = aConversionMap[psCookie];
        if (cmap) {
            this.writeCookielet(cmap[0], cmap[1], psVal, psExp);
            return;
        }
        var format = this.getFormat(psCookie);
        if (psVal && format.escapedValue) {
            psVal = encodeURIComponent(psVal);
        }
        this.writeRawCookie(psCookie, psVal, psExp);
    },

    //> private void writeRawCookie(String, String, String);
    //> private void writeRawCookie(String, String, int);
    writeRawCookie: function(psCookie, psVal, psExp) {  // jshint ignore:line
        if (psCookie && (psVal !== undefined)) {
            //    Uncomment secure related lines below and
            //    add to param list if it is being used
            //    var secure = pbSecure?"true":"";
            //    check for size limit
            if ((isNaN(psVal) && psVal.length < 4000) || (psVal + '').length < 4000) {
                if (typeof psExp === 'number') {
                    psExp = this.getExpDate(psExp);
                }
                var expDate = psExp ? new Date(psExp) : new Date(this.getExpDate(730));
                var format = this.getFormat(psCookie);
                //TODO: refactor domain logic before E513
                var sHost = this.sCookieDomain;
                var dd = document.domain;
                //if (!dd.has(sHost)) {
                if (dd.indexOf(sHost) === -1) {
                    var index = dd.indexOf('.ebay.');
                    if (index > 0) { // jshint ignore:line
                        this.sCookieDomain = dd.substring(index);
                    }
                }
                //Added check before writing the cookie
                if (document.cookie)
                {
                    document.cookie = psCookie + "=" + (psVal || "") +
                    ((psExp || format.bUseExp) ? "; expires=" + expDate.toGMTString() : "") +
                    "; domain=" + this.sCookieDomain +
                    "; path=" + sPath;
                    //        "; secure=" + secure;
                }
            }
        }
    },

    /**
    * Writes a value String to a given cookie. You can put the days to expired
    * this cookie from the current time.
    *
    * @param {String} cookie
    *        a string name of the cookie to be written
    * @param {String} value
    *        a string value to be written in cookie
    * @param {int} expDays
    *        the number of days that represents how long the cookie will be
    *        expired
    * @see #writeCookie
    */
    //>public void writeCookieEx(String,String,int);
    writeCookieEx: function(psCookie, psVal, piDays) {
        this.writeCookie(psCookie, psVal, this.getExpDate(piDays));
    },

    /**
    * Writes value to cookielet. You can use {@link writeMultiLineCookie} for
    * some multi-level cookielet.
    *
    * @param {String} cookie
    *        the name of the specified cookie which contains the cookielet to be
    *        write
    * @param {String} cookielet
    *        the name of the cookielet to be write
    * @param {String} val
    *        the value of the cookielet
    * @param {String} exp
    *        an expired date of the cookielet
    * @param {String} contExp
    *        an expired date of the cookie
    * @see #writeMultiLineCookie
    */
    //> public void writeCookielet(String,String,String,{int|String}?,{int|String}?);
    writeCookielet: function(psCookie, psCookielet, psVal, psExp, psContExp) { // jshint ignore:line
        //@param    pSec - secured? (optional)
        if (psCookie && psCookielet) {
            this.update();
            var format = this.getFormat(psCookie);
            if (format.bUseExp && psVal) {
                //Set the default exp date to 2 yrs from now
                if (typeof psExp === 'number') {
                    psExp = this.getExpDate(psExp);
                }
                var expDate = psExp ? new Date(psExp) : new Date(this.getExpDate(730)); //<Date
                var expDateUTC = Date.UTC(expDate.getUTCFullYear(), expDate.getUTCMonth(), expDate.getUTCDate(), expDate.getUTCHours(), expDate.getUTCMinutes(), expDate.getUTCSeconds()); // jshint ignore:line
                expDateUTC = Math.floor(expDateUTC / 1000);
                //psVal += expDateUTC.dec2Hex();
                psVal += parseInt(expDateUTC, 10).toString(16);
            }
            var val = this.createCookieValue(psCookie, psCookielet, psVal);
            this.writeRawCookie(psCookie, val, psContExp);
        }
    },

    /**
    * Writes value to some multi-level cookielet. Some cookielet contains sub
    * level, and you can use the name of the cookielet as cookie name and write
    * its sub level value.
    * These cookielet includes:
    * <p>
    * <pre>
    * Name as Cookie | name in cookielet         | upper level cookie
    * -------------- |---------------------------|----------------------
    * reg            | reg                       | dp1
    * recent_vi      | lvmn                      | ebay
    * ebaysignin     | sin                       | ebay
    * p              | p                         | dp1
    * etfc           | etfc                      | dp1
    * keepmesignin   | kms                       | dp1
    * BackToList     | BIBO_BACK_TO_LIST         | s
    * reg            | reg                       | dp1
    * </pre>
    * <p>
    * you need to use {@link writeCookielet} for other cookielet.
    *
    * @param {String} cookie
    *        the name of the specified cookie which contains the cookielet to be write
    * @param {String} cookielet
    *        the mame of the cookielet to be write
    * @param {String} val
    *        the value of the cookielet
    * @param {String} exp
    *        an expired date of the cookielet
    * @param {String} contExp
    *        an expired date of the cookie
    * @see #writeCookielet
    */
    //> public void writeMultiLineCookie(String,String,String,String,String);
    writeMultiLineCookie: function(psCookie, psCookielet, psVal, psExp, psContExp) { // jshint ignore:line
        this.update();
        var val = this.createCookieValue(psCookie, psCookielet, psVal);
        if (val) {
            var cmap = aConversionMap[psCookie];
            if (cmap) {
                this.writeCookielet(cmap[0], cmap[1], val, psExp, psContExp);
            }
        }
    },

    /**
    * Gets the bit flag value at a particular position.This function is
    * deprecated, use {@link #getBitFlag} instead.
    *
    * @deprecated
    * @param {String} dec
    *        a bit string that contains series of flags
    * @param {int} pos
    *        the flag position in the bit string
    * @return {int}
    *        the flag value
    * @see #getBitFlag
    */
    //> public int getBitFlagOldVersion(String, int);
    getBitFlagOldVersion: function(piDec, piPos) {
        //converting to dec
        var dec = parseInt(piDec, 10);//<Number
        //getting binary value //getting char at position
        var b = dec.toString(2), r = dec ? b.charAt(b.length - piPos - 1) : "";
        return (r == "1") ? 1 : 0; // jshint ignore:line
    },

    /**
    * Sets the bit flag at a particular position. This function is deprecated,
    * use {@link #setBitFlag} instead.
    *
    * @deprecated
    * @param {String} dec
    *        a bit string contains series of flags
    * @param {int} pos
    *        the flag position in the bit string
    * @param {int} val
    *        the flag value to be set. Flag will be set as 1 only if the value of
    *        this parameter is 1
    * @see #setBitFlag
    */
    //> public int setBitFlagOldVersion(int, int, int);
    setBitFlagOldVersion: function(piDec, piPos, piVal) {
        var b = "", p, i, e, l;
        //converting to dec
        piDec = parseInt(piDec + "", 10);
        if (piDec)
        {
            //getting binary value
            b = piDec.toString(2);
        }
        l = b.length;
        if (l < piPos)
        {
            e = piPos - l;
            for (i = 0; i <= e; i++)
            {
                b = "0" + b;
            }
        }
        //finding position
        p = b.length - piPos - 1;
        //replacing value at pPos with pVal and converting back to decimal
        return parseInt(b.substring(0, p) + piVal + b.substring(p + 1), 2);
    },

    /**
    * Gets the bit flag value at a particular position.
    *
    * @param {String} dec
    *        a bit string which contains series of flags
    * @param {int} pos
    *        the flag position in the bit string
    * @return {int}
    *        the flag value
    */
    //> public int getBitFlag(String,int);
    getBitFlag: function(piDec, piPos) {

        if (piDec !== null && piDec.length > 0 && piDec.charAt(0) === '#')
        {
            var length = piDec.length;
            var q = piPos % 4;
            var hexPosition = Math.floor(piPos / 4) + 1;

            var absHexPosition = length - hexPosition;
            var hexValue = parseInt(piDec.substring(absHexPosition, absHexPosition + 1), 16);
            var hexFlag = 1 << q;

            return ((hexValue & hexFlag) == hexFlag) ? 1 : 0; // jshint ignore:line
        }
        else
                {
                    //process by old format
                    return this.getBitFlagOldVersion(piDec, piPos);
                }

    },

    /**
    * Set the bit flag at a particular position.
    *
    * @param {String} dec
    *        A bit string that contains series of flags
    * @param {int} pos
    *        the flag position in the bit string
    * @param {int} val
    *        the falg value to be set. Flag will be set as 1 only if the value of
    *        this parameter is 1.
    */
    //> public int setBitFlag(String,int,int);
    //> public int setBitFlag(int,int,int);
    setBitFlag: function(piDec, piPos, piVal) { // jshint ignore:line

        if (piDec !== null && piDec.length > 0 && piDec.charAt(0) === '#')
        {
            //process by new format
            var length = piDec.length;
            var q = piPos % 4;
            var hexPosition = Math.floor(piPos / 4) + 1;

            if (length <= hexPosition)
            {
                if (piVal != 1) { // jshint ignore:line
                    return piDec;
                }

                var zeroCout = hexPosition - length + 1;
                var tmpString = piDec.substring(1, length);
                while (zeroCout > 0)
                {
                    tmpString = '0' + tmpString;
                    zeroCout--;
                }

                piDec = '#' + tmpString;
                length = piDec.length;
            }

            var absHexPosition = length - hexPosition;
            var hexValue = parseInt(piDec.substring(absHexPosition, absHexPosition + 1), 16);
            var hexFlag = 1 << q;

            if (piVal == 1) // jshint ignore:line
            {
                hexValue |= hexFlag;
            }
            else
                        {
                            hexValue &= ~hexFlag;
                        }

            piDec = piDec.substring(0, absHexPosition) + hexValue.toString(16) + piDec.substring(absHexPosition + 1, length); // jshint ignore:line

            return piDec;

        }
        else
                {
                    if (piPos > 31)
                    {
                        return piDec;
                    }
                    //process by old format
                    return this.setBitFlagOldVersion(piDec, piPos, piVal);
                }

    },

    //> private String  createCookieValue (String, String, String);
    createCookieValue: function(psName, psKey, psVal) { // jshint ignore:line
        var cmap = aConversionMap[psName], format = this.getFormat(psName),
                mode = this.getMode(psName), val;
        if (cmap && (mode == sSTRICT || mode == sCONVER)) { // jshint ignore:line
            val = this.readCookieObj(cmap[0], cmap[1]).value || "";
        }
        else {
            val = this.aCookies[psName] || "";
        }

        if (format) {
            var clts = this.getCookieletArray(val, format);
            clts[psKey] = psVal;
            var str = "";
            for (var i in clts) {
                if (clts.hasOwnProperty(i)) {
                    str += i + format.NAME_VALUE_DELIMITER + clts[i] + format.COOKIELET_DELIMITER;
                }
            }

            if (str && format.startDelim) {
                str = format.startDelim + str;
            }
            val = str;

            if (format.escapedValue) {
                val = encodeURIComponent(val);
            }
        }

        return val;
    },

    //> private void update();
    update: function() {
            //store cookie values
            var aC = document.cookie.split("; ");
            this.aCookies = {};
            var regE = new RegExp('^"(.*)"$');
            for (var i = 0; i < aC.length; i++) {
                var sC = aC[i].split("=");

                var format = this.getFormat(sC[0]), cv = sC[1], sd = format.startDelim;
                if (sd && cv && cv.indexOf(sd) === 0) {
                    sC[1] = cv.substring(sd.length, cv.length);
                }
                // check if the value is enclosed in double-quotes, then strip them
                if (sC[1] && sC[1].match(regE)) {
                    sC[1] = sC[1].substring(1, sC[1].length - 1);
                }
                this.aCookies[sC[0]] = sC[1];
            }
        },

    //> private String getCookielet(String, String, String);
    getCookielet: function(psCookie, psCookielet, psVal) {
        var format = this.getFormat(psCookie);
        var clts = this.getCookieletArray(psVal, format);
        return clts[psCookielet] || "";
    },

    //> private Object getFormat(String);
    getFormat: function(psCookie) {
        return aFormatMap[psCookie] || DEFAULT_COOKIE_FORMAT;
    },

    //> private Object getCookieletArray(String, Object);
    getCookieletArray: function(psVal, poFormat) {
        var rv = [], val = psVal || "";
        if (poFormat.escapedValue) {
            val = decodeURIComponent(val);
        }
        var a = val.split(poFormat.COOKIELET_DELIMITER);
        for (var i = 0; i < a.length; i++) { //create cookielet array
            var idx = a[i].indexOf(poFormat.NAME_VALUE_DELIMITER);
            if (idx > 0) {
                rv[a[i].substring(0, idx)] = a[i].substring(idx + 1);
            }
        }
        return rv;
    },

    /**
    * Gets the date behind a given days from current date. This is used to set
    * the valid time when writing the cookie.
    *
    * @param {int} days
    *        the number of days that cookie is valid
    * @return {String}
    *        the expiration date in GMT format
    */
    //> public String getExpDate(int);
    getExpDate: function(piDays) {
        var expires;
        if (typeof piDays === "number" && piDays >= 0) {
            var d = new Date();
            d.setTime(d.getTime() + (piDays * 24 * 60 * 60 * 1000));
            expires = d.toGMTString();
        }
        return expires;
    },

    //> private Object getMode(String);
    getMode: function(psCookie) { // jshint ignore:line
        var h = this.readCookieObj(sModesCookie, sModesCookielet).value,
                b,
                i;
        if (!(psCookie in aConversionMap)) {
            return null;
        }
        if (!h) {
            return "";
        }
        //default mode is STRICT when h is "0"
        if (h === 0) {
            return sSTRICT;
        }

        if (h && h != "0") { // jshint ignore:line
            //checking for h is having "." or not
            //if (h.has(".")){
            if (h.indexOf(".") !== -1) {
                //conversion cookie is having more than 15 cookie values
                var a = h.split(".");
                //looping through array
                for (i = 0; i < a.length; i++) {
                    //taking the first hex nubmer and converting to decimal
                    //and converting to binary
                    b = parseInt(a[i], 16).toString(2) + b;
                }
            }
            else {
                //converting to decimal
                //converting to binary number
                b = parseInt(h, 16).toString(2);
            }
            //fill the convArray with appropriate mode values
            i = 0;
            //getting total binary string length
            var l = b.length, j;
            //looping through each cookie and filling mode of the cookie
            for (var o in aConversionMap)
            {
                //find the position to read
                j = l - (2 * (i + 1));
                //reading backwards 2 digits at a time
                var f = b.substring(j, j + 2).toString(10);
                f = (!f) ? sSTRICT : f;
                if (psCookie == o) // jshint ignore:line
                {
                    return (f.length === 1) ? "0" + f : f;
                }
                i++;
            }
            return null;
        }

        return null;

    },

    getMulti: function(piDec, piPos, piBits) {
        var r = "", i, _this = this;
        for (i = 0; i < piBits; i++) {
            r = _this.getBitFlag(piDec, piPos + i) + r ;
        }
        return parseInt(r, 2);
    },

    setMulti: function(piDec, piPos, piBits, piVal) {
        var i = 0, _this = this, v, l, e;
        //convert to binary and take piBits out of it
        v = piVal.toString(2).substring(0, piBits);
        l = v.length;
        if (l < piBits) {
            e = piBits - l;
            for (var j = 0; j < e; j++) {
                v = "0" + v;
            }
            l = l + e;
        }
        for (i = 0; i < l; i++) {
            piDec = _this.setBitFlag(piDec, piPos + i, v.substring(l - i - 1, l - i));
        }
        return piDec;
    },

    setJsCookie: function() {
        this.writeCookielet('ebay', 'js', '1');
    }

};

function eventInit() {
    var callback = function() {
        api.setJsCookie();
    };

    if (window.addEventListener) {
        window.addEventListener('beforeunload', callback);
    } else if (window.attachEvent) {
        window.attachEvent('onbeforeunload', callback);
    }

    if (typeof jQuery !== 'undefined' && typeof $ !== 'undefined') {
        $(document).bind("ajaxSend", callback);
    }
}

// Initialize the events
eventInit();

// expose the API in windows for core platform services - Tracking & EP
window['cookies-browser'] = api;

// expose the API as CommonJS module
module.exports = api;

});
$_mod.installed("site-speed-ebay$4.0.3", "raptor-pubsub", "1.0.5");
$_mod.main("/raptor-pubsub$1.0.5", "lib/index");
$_mod.builtin("events", "/events$1.1.1/events");
$_mod.def("/events$1.1.1/events", function(require, exports, module, __filename, __dirname) { // Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

function EventEmitter() {
  this._events = this._events || {};
  this._maxListeners = this._maxListeners || undefined;
}
module.exports = EventEmitter;

// Backwards-compat with node 0.10.x
EventEmitter.EventEmitter = EventEmitter;

EventEmitter.prototype._events = undefined;
EventEmitter.prototype._maxListeners = undefined;

// By default EventEmitters will print a warning if more than 10 listeners are
// added to it. This is a useful default which helps finding memory leaks.
EventEmitter.defaultMaxListeners = 10;

// Obviously not all Emitters should be limited to 10. This function allows
// that to be increased. Set to zero for unlimited.
EventEmitter.prototype.setMaxListeners = function(n) {
  if (!isNumber(n) || n < 0 || isNaN(n))
    throw TypeError('n must be a positive number');
  this._maxListeners = n;
  return this;
};

EventEmitter.prototype.emit = function(type) {
  var er, handler, len, args, i, listeners;

  if (!this._events)
    this._events = {};

  // If there is no 'error' event listener then throw.
  if (type === 'error') {
    if (!this._events.error ||
        (isObject(this._events.error) && !this._events.error.length)) {
      er = arguments[1];
      if (er instanceof Error) {
        throw er; // Unhandled 'error' event
      } else {
        // At least give some kind of context to the user
        var err = new Error('Uncaught, unspecified "error" event. (' + er + ')');
        err.context = er;
        throw err;
      }
    }
  }

  handler = this._events[type];

  if (isUndefined(handler))
    return false;

  if (isFunction(handler)) {
    switch (arguments.length) {
      // fast cases
      case 1:
        handler.call(this);
        break;
      case 2:
        handler.call(this, arguments[1]);
        break;
      case 3:
        handler.call(this, arguments[1], arguments[2]);
        break;
      // slower
      default:
        args = Array.prototype.slice.call(arguments, 1);
        handler.apply(this, args);
    }
  } else if (isObject(handler)) {
    args = Array.prototype.slice.call(arguments, 1);
    listeners = handler.slice();
    len = listeners.length;
    for (i = 0; i < len; i++)
      listeners[i].apply(this, args);
  }

  return true;
};

EventEmitter.prototype.addListener = function(type, listener) {
  var m;

  if (!isFunction(listener))
    throw TypeError('listener must be a function');

  if (!this._events)
    this._events = {};

  // To avoid recursion in the case that type === "newListener"! Before
  // adding it to the listeners, first emit "newListener".
  if (this._events.newListener)
    this.emit('newListener', type,
              isFunction(listener.listener) ?
              listener.listener : listener);

  if (!this._events[type])
    // Optimize the case of one listener. Don't need the extra array object.
    this._events[type] = listener;
  else if (isObject(this._events[type]))
    // If we've already got an array, just append.
    this._events[type].push(listener);
  else
    // Adding the second element, need to change to array.
    this._events[type] = [this._events[type], listener];

  // Check for listener leak
  if (isObject(this._events[type]) && !this._events[type].warned) {
    if (!isUndefined(this._maxListeners)) {
      m = this._maxListeners;
    } else {
      m = EventEmitter.defaultMaxListeners;
    }

    if (m && m > 0 && this._events[type].length > m) {
      this._events[type].warned = true;
      console.error('(node) warning: possible EventEmitter memory ' +
                    'leak detected. %d listeners added. ' +
                    'Use emitter.setMaxListeners() to increase limit.',
                    this._events[type].length);
      if (typeof console.trace === 'function') {
        // not supported in IE 10
        console.trace();
      }
    }
  }

  return this;
};

EventEmitter.prototype.on = EventEmitter.prototype.addListener;

EventEmitter.prototype.once = function(type, listener) {
  if (!isFunction(listener))
    throw TypeError('listener must be a function');

  var fired = false;

  function g() {
    this.removeListener(type, g);

    if (!fired) {
      fired = true;
      listener.apply(this, arguments);
    }
  }

  g.listener = listener;
  this.on(type, g);

  return this;
};

// emits a 'removeListener' event iff the listener was removed
EventEmitter.prototype.removeListener = function(type, listener) {
  var list, position, length, i;

  if (!isFunction(listener))
    throw TypeError('listener must be a function');

  if (!this._events || !this._events[type])
    return this;

  list = this._events[type];
  length = list.length;
  position = -1;

  if (list === listener ||
      (isFunction(list.listener) && list.listener === listener)) {
    delete this._events[type];
    if (this._events.removeListener)
      this.emit('removeListener', type, listener);

  } else if (isObject(list)) {
    for (i = length; i-- > 0;) {
      if (list[i] === listener ||
          (list[i].listener && list[i].listener === listener)) {
        position = i;
        break;
      }
    }

    if (position < 0)
      return this;

    if (list.length === 1) {
      list.length = 0;
      delete this._events[type];
    } else {
      list.splice(position, 1);
    }

    if (this._events.removeListener)
      this.emit('removeListener', type, listener);
  }

  return this;
};

EventEmitter.prototype.removeAllListeners = function(type) {
  var key, listeners;

  if (!this._events)
    return this;

  // not listening for removeListener, no need to emit
  if (!this._events.removeListener) {
    if (arguments.length === 0)
      this._events = {};
    else if (this._events[type])
      delete this._events[type];
    return this;
  }

  // emit removeListener for all listeners on all events
  if (arguments.length === 0) {
    for (key in this._events) {
      if (key === 'removeListener') continue;
      this.removeAllListeners(key);
    }
    this.removeAllListeners('removeListener');
    this._events = {};
    return this;
  }

  listeners = this._events[type];

  if (isFunction(listeners)) {
    this.removeListener(type, listeners);
  } else if (listeners) {
    // LIFO order
    while (listeners.length)
      this.removeListener(type, listeners[listeners.length - 1]);
  }
  delete this._events[type];

  return this;
};

EventEmitter.prototype.listeners = function(type) {
  var ret;
  if (!this._events || !this._events[type])
    ret = [];
  else if (isFunction(this._events[type]))
    ret = [this._events[type]];
  else
    ret = this._events[type].slice();
  return ret;
};

EventEmitter.prototype.listenerCount = function(type) {
  if (this._events) {
    var evlistener = this._events[type];

    if (isFunction(evlistener))
      return 1;
    else if (evlistener)
      return evlistener.length;
  }
  return 0;
};

EventEmitter.listenerCount = function(emitter, type) {
  return emitter.listenerCount(type);
};

function isFunction(arg) {
  return typeof arg === 'function';
}

function isNumber(arg) {
  return typeof arg === 'number';
}

function isObject(arg) {
  return typeof arg === 'object' && arg !== null;
}

function isUndefined(arg) {
  return arg === void 0;
}

});
$_mod.def("/raptor-pubsub$1.0.5/lib/raptor-pubsub", function(require, exports, module, __filename, __dirname) { var EventEmitter = require('/events$1.1.1/events'/*'events'*/).EventEmitter;

var channels = {};

var globalChannel = new EventEmitter();

globalChannel.channel = function(name) {
    var channel;
    if (name) {
        channel = channels[name] || (channels[name] = new EventEmitter());
    } else {
        channel = new EventEmitter();
    }
    return channel;
};

globalChannel.removeChannel = function(name) {
    delete channels[name];
};

module.exports = globalChannel;

});
$_mod.def("/raptor-pubsub$1.0.5/lib/index", function(require, exports, module, __filename, __dirname) { var g = typeof window === 'undefined' ? global : window;
// Make this module a true singleton
module.exports = g.__RAPTOR_PUBSUB || (g.__RAPTOR_PUBSUB = require('/raptor-pubsub$1.0.5/lib/raptor-pubsub'/*'./raptor-pubsub'*/));
});
$_mod.installed("site-speed-ebay$4.0.3", "core-site-speed-ebay", "1.0.4");
$_mod.main("/core-site-speed-ebay$1.0.4", "SiteSpeed");
$_mod.def("/core-site-speed-ebay$1.0.4/SiteSpeed", function(require, exports, module, __filename, __dirname) { module.exports = function(gaugeInfo, Uri, ebayCookies, metrics) { // jshint ignore:line 

/*
* Context of Site Speed:
*   context: {
*     gaugeInfo: <gaugeInfo>,
*     beacon: <beacon uri>,
*     cookies: <cookies>
*   }
* 
* Interface Spec:
*  beacon should contain APIs:
*    - function add(beacon, value) {...}
*    - function remove(beacon) {...}
*    - function getUrl() {...; return <url>; }
*
*  cookies should contain APIs:
*    - function readCookie(cookie, cookielet) {...; return <value of cookielet>;}
*    - function writeCookielet(cookie, cookielet, value) {...}
*    - function getBitFlag(bits, position) {...; return <value of positioned bit>;}
*    - function setBitFlag(bits, position, 1|0) {...}
*  
*  errors should contain APIs:
*    - function init() {...}
*    - function getLength() {...; return <length of errors>;}
*    - function getString() {...; return <error strings>;}
*  
*  metrics should contain APIs:
*    - function getEntries() {...; return <[{'key':<key>,'value':<value>},...] of metrics>;}
* 
*/

function SiteSpeed(context) {

    function getResourceTimingTag() {

        var validInitiators = {'all':1, 'link':2, 'script':3, 'img':4, 'css':5, 'iframe':6, 'object':7, 'embed':8, 'svg':9, 'xmlhttprequest':10};
        
        function isValidInitiator(initiator) {
            return validInitiators.hasOwnProperty(initiator);
        }
        function sort(ranges) {
            if (!ranges) {
                return [];
            }
            ranges.sort(function(a, b){
                var a_start = a[0], a_end = a[1];
                var b_start = b[0], b_end = b[1];
                return (a_start == b_start
                   ? (a_end == b_end
                    ? 0
                    : (a_end < b_end ? -1 : 1))
                   : (a_start < b_start ? -1 : 1));
            });
            return ranges;
        }
        // Parameter ranges is a sorted range array: [[start, end], ... ]
        // Return startOffset_range_duration
        // startOffset is the minimum start of the ranges.
        // duration is 'maximum end' - 'minimum start' of the ranges.
        // range is all the ranges which remove the overlaps and gaps
        // for more refer
        function join(ranges) { 
            function overlap(a, b) {
                var left = Math.max(a[0], b[0]);
                var right = Math.min(a[1], b[1]);
                return (left <= right ? true : false);
            }
            if (!ranges || ranges.length == 0) {
                return '';
            }  
            var range = 0;
            var current = [ranges[0][0], ranges[0][1]];
            var startOffset = ranges[0][0]; 
            var maxEnd = ranges[0][1];
            for (var i=1; i<ranges.length; i++) {
                var target = ranges[i];
                maxEnd = Math.max(maxEnd, target[1]);
                if (overlap(current, target)) {
                    current[1] = Math.max(current[1], target[1]);
                } else {
                    range += (current[1] - current[0]);
                    current = [target[0], target[1]];
                }
            }
            range += (current[1] - current[0]);
            //startOffset_range_duration
            return startOffset.toFixed(0) + '_' + range.toFixed(0) + '_' + (maxEnd-startOffset).toFixed(0);
        }

        //ignore if browser does not support resource timing API
        var performance = getPerformance();
        if ( !performance ||
         !('getEntriesByType' in performance) ||
         !(performance.getEntriesByType('resource') instanceof Array)) {
            return '';
        }

        var entries = performance.getEntriesByType('resource');

        if (!entries) {
            return '';
        }
        var allHosts = {};
        var ebayHosts = {};
        var nonEbayHosts = {}; 
        var hosts = {};
        entries.forEach(function(entry, i){
            var requestStart = entry.requestStart;
            //cross domain case, use fetchStart instead
            if (!requestStart) {
                requestStart = entry.fetchStart;
            }

            //ignore not valid hostname case
            if(entry.name.indexOf("http://") != 0 && entry.name.indexOf("https://") != 0) 
                return;

            var host = entry.name.split('/')[2];
            var theInitiatorType = entry.initiatorType;
            //work around since notice that firefox use 'subdocument' instead of 'iframe' 
            if(theInitiatorType === 'subdocument') {
                theInitiatorType = 'iframe';
            }

            //validate initiator type and range
            if(!isValidInitiator(theInitiatorType) || requestStart > entry.responseEnd) {
                return;
            }

            // add to specific host case
            hosts[host] = hosts[host] || {};
            hosts[host][theInitiatorType] = hosts[host][theInitiatorType] || [];
            hosts[host][theInitiatorType].push([requestStart, entry.responseEnd]);
            hosts[host]['all'] =  hosts[host]['all'] || [];
            hosts[host]['all'].push([requestStart, entry.responseEnd]);
            //  add to all hosts case
            allHosts[theInitiatorType] = allHosts[theInitiatorType] || [];
            allHosts[theInitiatorType].push([requestStart, entry.responseEnd]);
            allHosts['all'] =  allHosts['all'] || [];
            allHosts['all'].push([requestStart, entry.responseEnd]);
            if (host.indexOf('ebay') > -1) {
                ebayHosts[theInitiatorType] = ebayHosts[theInitiatorType] || [];
                ebayHosts[theInitiatorType].push([requestStart, entry.responseEnd]);
                ebayHosts['all'] = ebayHosts['all'] || [];
                ebayHosts['all'].push([requestStart, entry.responseEnd]);
            } else {
                nonEbayHosts[theInitiatorType] = nonEbayHosts[theInitiatorType] || [];
                nonEbayHosts[theInitiatorType].push([requestStart, entry.responseEnd]);
                nonEbayHosts['all'] = nonEbayHosts['all'] || [];
                nonEbayHosts['all'].push([requestStart, entry.responseEnd]);
            }
        });

        var rsTimingTag = '';
        // generate beacon url for fixed part: nonEbayHosts, ebayHosts and allHosts
        [['nonebay', nonEbayHosts], 
        ['ebay',  ebayHosts], 
        ['*',  allHosts]].forEach(function(entry, i){
            if (rsTimingTag) rsTimingTag += '!';
            rsTimingTag += entry[0];

            Object.keys(validInitiators).forEach(function(initiator, initiatorIndex){
                rsTimingTag += '~' + join(sort(entry[1][initiator]));
            });
            
        });
        // generate beacon url for all individual hosts
        Object.keys(hosts).forEach(function(host, i){
            rsTimingTag += '!' + host;
            
            Object.keys(validInitiators).forEach(function(initiator, initiatorIndex){
                rsTimingTag += '~' + join(sort(hosts[host][initiator]));
            });
        });
        return rsTimingTag;
    }

    //Get 'window.performance.timing'
    function getTiming() {
        var performance = getPerformance();
        return performance ? performance.timing : 'undefined';
    }

    //Get 'window.performance'
    function getPerformance() {
        return window.performance || window.msPerformance || window.webkitPerformance || window.mozPerformance;
    }

    this.init = function () {

        // 1. initialize gaugeInfo: ut, bf, sent, ld, wt, ex3, ct21
        var gaugeInfo = context.gaugeInfo;
        if (typeof(gaugeInfo) != 'undefined') {
            var bf = 0;
            var ut = null;
            var cookies = context.cookies;
            if (cookies) {
                var sbf = cookies.readCookie("ebay","sbf");
                if (sbf) {
                    bf = cookies.getBitFlag(sbf, 20);
                }
                if (!bf) {
                    cookies.writeCookielet("ebay","sbf", cookies.setBitFlag(sbf, 20, 1));
                }
                ut = cookies.readCookie('ds2', 'ssts');
            }
            gaugeInfo.ut = ut;
            gaugeInfo.bf = bf;
            gaugeInfo.sent = false;
            gaugeInfo.ld = false;
            gaugeInfo.wt = 0;
            gaugeInfo.ex3 = 0;
            gaugeInfo.ct21 = 0;
            if (typeof(gaugeInfo.iLoadST) == 'undefined') {
                gaugeInfo.iLoadST = Date.now();
            }
			
            var errors = context.errors;
            if (errors) {
                errors.init();
            }
            
            // initialize resource timing buffer size
            var performance = getPerformance();
            if (gaugeInfo.bRsTiming && 'getEntriesByType' in performance) {
                performance.setResourceTimingBufferSize = performance.setResourceTimingBufferSize
                                                       || performance.webkitSetResourceTimingBufferSize
                                                       || performance.mozSetResourceTimingBufferSize
                                                       || performance.msSetResourceTimingBufferSize
                                                       || performance.oSetResourceTimingBufferSize
                                                       || performance.webkitSetResourceTimingBufferSize;
                if (typeof performance.setResourceTimingBufferSize === "function") {
                    performance.setResourceTimingBufferSize(300); //expand the buffer to 300
                }
            }
            
        }

    }

    this.onLoad = function () {

        // 1. initialize gaugeInfo: ld, wt, ex3, ct21, jseaa, jseap, ct1chnk, jsljgr3, svo, jsljgr1, slo, ua
        // 2. send beacon if browser is ff, Safari or Chrome
        var gaugeInfo = context.gaugeInfo;
        if (typeof(gaugeInfo) != 'undefined') {
            var cookies = context.cookies;
            if (cookies) {
                var sbf = cookies.readCookie('ebay', 'sbf');
                if (sbf) {
                    cookies.writeCookielet('ebay', 'sbf', cookies.setBitFlag(sbf, 20, 1));
                }
            }

            gaugeInfo.ld = true;

            var now = Date.now();
            gaugeInfo.wt = now;
            gaugeInfo.ex3 = now;
            gaugeInfo.ct21 = now - gaugeInfo.iST;

            var timing = getTiming();
            var beacon = context.beacon;
            if (timing) {
                beacon.add('ex3', now - timing.navigationStart); // end to end at client, also log to cal tx
                beacon.add('jseaa', now - timing.responseStart); // client rendering = ct21, was ctidl before
                beacon.add('jseap', timing.responseStart - timing.navigationStart); // first byte time (jsebca before not in batch)
                beacon.add('ct1chnk', timing.domComplete - timing.responseStart); // dom complete
                beacon.add('jsljgr3', timing.domainLookupEnd - timing.domainLookupStart); // dns lookup time
                beacon.add('svo', timing.connectEnd - timing.connectStart); // connection time, also log to cal tx
                beacon.add('jsljgr1', timing.responseStart - timing.requestStart); // request time
                beacon.add('slo', timing.responseEnd - timing.responseStart); // content download time
				
                // SSL negotiation time
                if (timing.secureConnectionStart) {
                    var i_ssl = timing.connectEnd - timing.secureConnectionStart;
                    if (i_ssl > 0) {
                        beacon.add('i_ssl', i_ssl);
                    }
                }
            }

            // Adding first paint
            var rsfp, fpTime, ltfpsec;
            if (timing && timing.msFirstPaint) {
                // msFirstPaint is in milliseconds
                // msFirstPaint is IE9+ http://msdn.microsoft.com/en-us/library/ff974719
                //fpTime = timings.msFirstPaint < this.fpt ? 
                rsfp = timing.msFirstPaint - timing.responseStart;
                //mozilla
            } else if (window.chrome && window.chrome.loadTimes) {
                // firstPaintTime below is in seconds.microseconds.  The server needs to deal with this.
                // This is Chrome only, so will not overwrite nt_first_paint above
                var lt = window.chrome.loadTimes(),
                    ltfpsec, ltfpmsec;
                if (lt) {
                    ltfpsec = lt.firstPaintTime + ""
                    ltfpsec = ltfpsec.split(".")[0]; //ignoring the microsecond part
                    ltfpsec = parseInt(ltfpsec, 10);
                    // ltfpmsec = ltfpsec * 1000; //converting to ms
                    ltsltsec = lt.startLoadTime + "";
                    ltsltsec = ltsltsec.split(".")[0];
                    ltsltsec = parseInt(ltsltsec, 10);
                    // ltsltmsec = ltsltsec * 1000;
                    rsfp = ltfpsec - ltsltsec;
                    rsfp = rsfp * 1000; //converting to ms
                }
            }
            if (rsfp > 0) {
                beacon.add('i_firstpaint', rsfp);
            }

            var defer = 0;
            if(gaugeInfo.deferExecInMs){
                defer = gaugeInfo.deferExecInMs;
            }

            // lock down resource timing buffer size upon onload event
            var performance = getPerformance();
            if (gaugeInfo.bRsTiming && 'getEntriesByType' in performance) {
                performance.setResourceTimingBufferSize = performance.setResourceTimingBufferSize
                                                        || performance.webkitSetResourceTimingBufferSize
                                                        || performance.mozSetResourceTimingBufferSize
                                                        || performance.msSetResourceTimingBufferSize
                                                        || performance.oSetResourceTimingBufferSize
                                                        || performance.webkitSetResourceTimingBufferSize;
                if (typeof performance.setResourceTimingBufferSize === "function") {
                    var max = performance.getEntriesByType('resource').length;
                    performance.setResourceTimingBufferSize(max - 1 > 0 ? max - 1 : 0);
                }
            }

            if ((isSafari() || isFireFox()) && !isSendBeaconAPIAvailable()) { //For old FireFox and current Safari
                var this_ = this;
                setTimeout(function () {
                    this_.sendBeacon('onload', false, false);
                }, defer);
            }
        }
    }

    this.onBeforeunload = function () {

        // 1. write cookie
        // 2. send beacon

        var cookies = context.cookies;
        if (cookies) {
            cookies.writeCookielet("ds2", "ssts", Date.now());
        }

        this.sendBeacon('unload', false, isSafari() || isFireFox()); //For current FireFox and future Safari

    }

    this.sendBeacon = function (event, immediate, useSendBeaconAPI) {

        // 1. set params: ex2, ex1, ct21, ctb, st1a, jslcom, jseo, jsllib1, jsllib2, jsllib3, jslpg, jslss, jslsys, sgwt, i_30i, (s_rstm), sgbld, emsg, i_nev2elc
        // 2. send beacons
        var gaugeInfo = context.gaugeInfo;
        if (typeof(gaugeInfo) == 'undefined') {
        	return;
        }
        if (gaugeInfo.sent == 1) {
        	return;
        }

        var beacon = context.beacon;

        if (immediate) {

            if (gaugeInfo.bRsTiming) {
                var s_rstm = getResourceTimingTag();
                if (s_rstm) {
                    beacon.add('s_rstm', s_rstm);
                }
            }

            var errors = context.errors;
            if (errors && errors.getLength()) {
                beacon.add('sgbld', errors.getLength());
                beacon.add('emsg', errors.getString());
            }

            var timing = getTiming();
            if (timing) {
                var i_nve2elc =  timing.loadEventEnd - timing.navigationStart;
                if (i_nve2elc > 0) {
                    beacon.add('i_nve2elc', i_nve2elc);
                }
            }

            if (gaugeInfo.bf) {
                beacon.remove('st1');
            }

            var beaconURL = beacon.getUrl();
            if (beaconURL.indexOf('?') < 0) {
                beaconURL += '?now=' + Date.now();
            }
			            
            var metrics = context.metrics;
            if (metrics) {
                var entries = metrics.getEntries();
                for (var index in entries) {
                    beaconURL += '&' + entries[index].key + '=' + entries[index].value;
                }
            }
			
            // fire beacon
            if (useSendBeaconAPI) {
                navigator.sendBeacon(beaconURL);
            } else {
                new Image().src = beaconURL;
            }

            // mark sent
            gaugeInfo.sent = 1;

            return;
        }

        // earlier exit case
        if (!gaugeInfo.ld) {
            beacon.add('ex2', Date.now() - gaugeInfo.iST);
            this.sendBeacon(event, true, useSendBeaconAPI);
        	return;
        }

        if (gaugeInfo.bf) {
            // cached page case
            beacon.add('ex1', '1');
        } else {
            beacon.add('ct21', gaugeInfo.ct21);
            if (gaugeInfo.iLoadST) {
                beacon.add('ctb', gaugeInfo.iLoadST - gaugeInfo.iST);
            }
            if (gaugeInfo.st1a) {
                beacon.add('st1a', gaugeInfo.st1a);
            }
            if (gaugeInfo.aChunktimes && gaugeInfo.aChunktimes.length) {
            	// progressive rendering chunks
                beacon.add('jslcom', gaugeInfo.aChunktimes.length);
                var chunkTimeParamNames = [
                    "jseo",
                    "jsllib1",
                    "jsllib2",
                    "jsllib3",
                    "jslpg",
                    "jslss",
                    "jslsys"
                ];
                var chunkTimesLen = gaugeInfo.aChunktimes.length;
                for (var i = 0, chunkTimeParamName; i < chunkTimesLen; i++) { // jshint ignore:line
                    if ((chunkTimeParamName = chunkTimeParamNames[i])) {
                        beacon.add(chunkTimeParamName, gaugeInfo.aChunktimes[i]);
                    }
                }
            }
        }

        if (event == 'onload') {
            if (gaugeInfo.deferExecInMs > 0) {
                gaugeInfo.wt = Date.now() - gaugeInfo.wt;
                beacon.add('sgwt', gaugeInfo.wt);
                beacon.add('i_30i', gaugeInfo.wt);
            } else {
                gaugeInfo.wt = 0;
            }
        } else {
            gaugeInfo.wt = Date.now() - gaugeInfo.wt;
            beacon.add('sgwt', gaugeInfo.wt);
        }

        if (gaugeInfo.wt < 60000 * 20) { // ignore > 20 min to prevent incorrect st21
            this.sendBeacon(event, true, useSendBeaconAPI);
        }

    }

    function isSendBeaconAPIAvailable() {
        return 'sendBeacon' in navigator;
    }

    function isFireFox() {
        return navigator.userAgent.indexOf("Firefox/") > 0;
    }

    function isSafari() {
        return navigator.userAgent.indexOf("Safari") > 0 && navigator.userAgent.indexOf("Chrome") < 0;
    }
}

var uri = Uri.create(gaugeInfo.sUrl);
var errors = [];
var context = {
    gaugeInfo: gaugeInfo,
    cookies: ebayCookies,
    beacon: {
        add: function(beacon, value) {
            return uri.params[beacon] = value;
        },
        remove: function(beacon) {
            delete uri.params[beacon];
        },
        getUrl: function() {
            for (var ps in uri.params) {
                if (Array.isArray(uri.params[ps])) {
                    var undefinedIndex = uri.params[ps].indexOf(undefined);
                    if (undefinedIndex > -1) {
                        uri.params[ps].splice(undefinedIndex, 1);
                    }
                }
            }
            return uri.getUrl();
        }
    },
    errors: {
        init: function() {
            window.onerror = (function (oldHandler, errors) {
                return function(message, url, lineNumber) {
                    errors.push({message: message, url: url, lineNumber: lineNumber});
                    if (oldHandler) {
                        return oldHandler.apply(this, arguments);
                    } else {
                        return false;
                    }
                }
            }) (window.onerror, errors);
        },
        getLength: function() {
            return errors.length;
        },
        getString: function() {
            return (function(errors) {
                var parts = [];
                for (var i = 0, len = errors.length; i < len; i++) {
                    var err = errors[i];
                    parts.push("js-err-line-" + err.lineNumber + "-msg-" + err.message + "-url-" + err.url);
                }
                return parts.join("|");
            })(errors);
        }
    },
    metrics: {
        getEntries: function() {
            var entries = [];
            var _metrics = metrics.get();
            if (typeof(_metrics) != "undefined") {
                for (var key in _metrics) {
                    if (_metrics.hasOwnProperty(key)) {
                        entries.push({"key": key, "value": _metrics[key]});
                    }
                }
            }
            return entries;
        }
    }
};

var script = new SiteSpeed(context);
script.init();

$(window).on("load", function() { script.onLoad(); })
    .on("beforeunload", function() { script.onBeforeunload(); });

};
});
$_mod.installed("site-speed-ebay$4.0.3", "raptor-util", "3.2.0");
$_mod.main("/raptor-util$3.2.0", "raptor-util");
$_mod.def("/raptor-util$3.2.0/tryRequire", function(require, exports, module, __filename, __dirname) { 
module.exports = function(id, require) {
    var path;
    
    try {
        path = require.resolve(id);
    }
    catch(e) {}

    if (path) {
        return require(path);
    }
};
});
$_mod.def("/raptor-util$3.2.0/copyProps", function(require, exports, module, __filename, __dirname) { module.exports = function copyProps(from, to) {
    Object.getOwnPropertyNames(from).forEach(function(name) {
        var descriptor = Object.getOwnPropertyDescriptor(from, name);
        Object.defineProperty(to, name, descriptor);
    });
};
});
$_mod.def("/raptor-util$3.2.0/inherit", function(require, exports, module, __filename, __dirname) { var copyProps = require('/raptor-util$3.2.0/copyProps'/*'./copyProps'*/);

function inherit(ctor, superCtor, shouldCopyProps) {
    var oldProto = ctor.prototype;
    var newProto = ctor.prototype = Object.create(superCtor.prototype, {
        constructor: {
            value: ctor,
            writable: true,
            configurable: true
        }
    });
    if (oldProto && shouldCopyProps !== false) {
        copyProps(oldProto, newProto);
    }
    ctor.$super = superCtor;
    ctor.prototype = newProto;
    return ctor;
}


module.exports = inherit;
inherit._inherit = inherit;

});
$_mod.def("/raptor-util$3.2.0/makeClass", function(require, exports, module, __filename, __dirname) { var inherit = require('/raptor-util$3.2.0/inherit'/*'./inherit'*/);

module.exports = function(clazz) {
    var superclass;

    if (typeof clazz === 'function') {
        superclass = clazz.$super;
    }
    else {
        var o = clazz;
        clazz = o.$init || function() {};
        superclass = o.$super;

        delete o.$super;
        delete o.$init;

        clazz.prototype = o;
    }
    
    if (superclass) {
        inherit(clazz, superclass);
    }

    var proto = clazz.prototype;
    proto.constructor = clazz;
    
    return clazz;
};
});
$_mod.def("/raptor-util$3.2.0/extend", function(require, exports, module, __filename, __dirname) { module.exports = function extend(target, source) { //A simple function to copy properties from one object to another
    if (!target) { //Check if a target was provided, otherwise create a new empty object to return
        target = {};
    }

    if (source) {
        for (var propName in source) {
            if (source.hasOwnProperty(propName)) { //Only look at source properties that are not inherited
                target[propName] = source[propName]; //Copy the property
            }
        }
    }

    return target;
};
});
$_mod.def("/raptor-util$3.2.0/forEachEntry", function(require, exports, module, __filename, __dirname) { /**
 * Invokes a provided callback for each name/value pair
 * in a JavaScript object.
 *
 * <p>
 * <h2>Usage</h2>
 * <js>
 * raptor.forEachEntry(
 *     {
 *         firstName: "John",
 *         lastName: "Doe"
 *     },
 *     function(name, value) {
 *         console.log(name + '=' + value);
 *     },
 *     this);
 * )
 * // Output:
 * // firstName=John
 * // lastName=Doe
 * </js>
 * @param  {Object} o A JavaScript object that contains properties to iterate over
 * @param  {Function} fun The callback function for each property
 * @param  {Object} thisp The "this" object to use for the callback function
 * @return {void}
 */
module.exports = function(o, fun, thisp) {
    for (var k in o)
    {
        if (o.hasOwnProperty(k))
        {
            fun.call(thisp, k, o[k]);
        }
    }
};
});
$_mod.def("/raptor-util$3.2.0/makeEnum", function(require, exports, module, __filename, __dirname) { var makeClass = require('/raptor-util$3.2.0/makeClass'/*'./makeClass'*/);
var extend = require('/raptor-util$3.2.0/extend'/*'./extend'*/);
var forEachEntry = require('/raptor-util$3.2.0/forEachEntry'/*'./forEachEntry'*/);

module.exports = function(enumValues, Ctor) {
    if (Ctor) {
        Ctor = makeClass(Ctor);
    } else {
        Ctor = function () {};
    }

    var proto = Ctor.prototype;
    var count = 0;

    function _addEnumValue(name, EnumCtor) {
        var ordinal = count++;
        return extend(Ctor[name] = new EnumCtor(), {
            ordinal: ordinal,
            compareTo: function(other) {
                return ordinal - other.ordinal;
            },
            name: name
        });
    }

    function EnumCtor() {}

    if (Array.isArray(enumValues)) {
        enumValues.forEach(function (name) {
            _addEnumValue(name, Ctor);
        });
    } else if (enumValues) {
        EnumCtor.prototype = proto;
        forEachEntry(enumValues, function (name, args) {
            Ctor.apply(_addEnumValue(name, EnumCtor), args || []);
        });
    }

    Ctor.valueOf = function (name) {
        return Ctor[name];
    };


    if (proto.toString == Object.prototype.toString) {
        proto.toString = function() {
            return this.name;
        };
    }

    return Ctor;
};
});
$_mod.def("/raptor-util$3.2.0/forEach", function(require, exports, module, __filename, __dirname) { /**
 * Utility method to iterate over elements in an Array that
 * internally uses the "forEach" property of the array.
 *
 * <p>
 * If the input Array is null/undefined then nothing is done.
 *
 * <p>
 * If the input object does not have a "forEach" method then
 * it is converted to a single element Array and iterated over.
 *
 *
 * @param  {Array|Object} a An Array or an Object
 * @param  {Function} fun The callback function for each property
 * @param  {Object} thisp The "this" object to use for the callback function
 * @return {void}
 */
module.exports = function(a, func, thisp) {
    if (a != null) {
        (a.forEach ? a : [a]).forEach(func, thisp);
    }
};
});
$_mod.def("/raptor-util$3.2.0/createError", function(require, exports, module, __filename, __dirname) { module.exports = function(message, cause) {
    var error;
    var argsLen = arguments.length;
    var E = Error;
    
    if (argsLen == 2) {
        error = message instanceof E ? message : new E(message);
        if (error.stack) {
            error.stack += '\nCaused by: ' + (cause.stack || cause);
        } else {
            error._cause = cause;    
        }
    } else if (argsLen == 1) {
        error = message instanceof E ? message : new E(message);
    }
    
    return error;
};
});
$_mod.def("/raptor-util$3.2.0/arrayFromArguments", function(require, exports, module, __filename, __dirname) { var slice = [].slice;

module.exports = function(args, startIndex) {
    if (!args) {
        return [];
    }
    
    if (startIndex) {
        return startIndex < args.length ? slice.call(args, startIndex) : [];
    }
    else
    {
        return slice.call(args);
    }
};
});
$_mod.def("/raptor-util$3.2.0/isObjectEmpty", function(require, exports, module, __filename, __dirname) { module.exports = function isObjectEmpty(o) {
    if (!o) {
        return true;
    }
    
    for (var k in o) {
        if (o.hasOwnProperty(k)) {
            return false;
        }
    }
    return true;
};
});
$_mod.def("/raptor-util$3.2.0/toArray", function(require, exports, module, __filename, __dirname) { var slice = [].slice;

module.exports = function toArray(o) {
    if (o == null || Array.isArray(o)) {
        return o;
    }

    if (typeof o === 'string') {
        return o.split('');
    }

    if (o.length) {
        return slice.call(o, 0);
    }

    return [o];
};
});
$_mod.def("/raptor-util$3.2.0/raptor-util", function(require, exports, module, __filename, __dirname) { module.exports = {
    tryRequire: require('/raptor-util$3.2.0/tryRequire'/*'./tryRequire'*/),
    inherit: require('/raptor-util$3.2.0/inherit'/*'./inherit'*/),
    makeClass: require('/raptor-util$3.2.0/makeClass'/*'./makeClass'*/),
    makeEnum: require('/raptor-util$3.2.0/makeEnum'/*'./makeEnum'*/),
    extend: require('/raptor-util$3.2.0/extend'/*'./extend'*/),
    forEachEntry: require('/raptor-util$3.2.0/forEachEntry'/*'./forEachEntry'*/),
    forEach: require('/raptor-util$3.2.0/forEach'/*'./forEach'*/),
    createError: require('/raptor-util$3.2.0/createError'/*'./createError'*/),
    arrayFromArguments: require('/raptor-util$3.2.0/arrayFromArguments'/*'./arrayFromArguments'*/),
    isObjectEmpty: require('/raptor-util$3.2.0/isObjectEmpty'/*'./isObjectEmpty'*/),
    toArray: require('/raptor-util$3.2.0/toArray'/*'./toArray'*/)
};
});
$_mod.def("/site-speed-ebay$4.0.3/client/uri", function(require, exports, module, __filename, __dirname) { //jscs:disable safeContextKeyword
'use strict';
/**
* Gets the meta tag with specified attribute name and value.
*
* @param {String} name
*        the attribute name of the meta tag
* @param {String} value
*        the value of the specified attribute
* @return {String}
*        the reference of the meta tag. If no such meta exists, return
*        <code>null</code>
*/
//> public Object meta(String, String);
var meta = function(name, value) {
        var tags = document.getElementsByTagName('meta');
        for (var idx = 0, len = tags.length; idx < len; idx++) {
            if (tags[idx].getAttribute(name) == value) { // jshint ignore:line
                return tags[idx];
            }
        }
        return null;
    };

var content = meta('http-equiv', 'Content-Type') || meta('httpEquiv', 'Content-Type');
var charset = (content) ? content.getAttribute('content') : null;

var encodeUri = (charset && charset.match(/utf/gi)) ? encodeURI : window.escape;
var decodeUri = (charset && charset.match(/utf/gi)) ? decodeURI : window.unescape;

var encodeParam = (charset && charset.match(/utf/gi)) ? encodeURIComponent : window.escape;
var decodeParam = (charset && charset.match(/utf/gi)) ? decodeURIComponent : window.unescape;

var uriMatch = new RegExp('(([^:]*)://([^:/?]*)(:([0-9]+))?)?([^?#]*)([?]([^#]*))?(#(.*))?');

var utils = require('/raptor-util$3.2.0/raptor-util'/*'raptor-util'*/);

/**
* @construct
* @param {String} href
*        a uri string to be parsed
*/
//> public void Uri(String href);
var Uri = function(href) {

    var self = this;self.params = {};
    var match = href.match(uriMatch);
    if (match === null) {
        return;
    }

    self.protocol = self.match(match, 2);

    self.host = self.match(match, 3);
    self.port = self.match(match, 5);

    self.href = self.match(match, 6);
    self.query = self.match(match, 8);

    if (self.href.match(/eBayISAPI.dll/i)) {
        self.decodeIsapi(self.query);
    } else {
        self.decodeParams(self.query);
    }

    self.href = decodeUri(self.href);
    self.hash = self.match(match, 10);

};

utils.extend(Uri.prototype, {

    //> private String match(Object match,int idx);
    match: function(match, idx) {
            return ((match.length > idx) && match[idx]) ? match[idx] : '';
        },

    //> private void decodeIsapi(String);
    decodeIsapi: function(query) {
            var params = (query) ? query.split('&') : [];
            this.isapi = params.shift();this.query = params.join('&');
            this.decodeParams(this.query);
        },

    /**
    * Adds a name-value pair as a parameter. The function allows duplicate
    * attributes with different values. The name-value pair is registered in a
    * parameter array. You can specify this parameter array and by default this
    * class has a internal array which is used to build the uri.
    *
    * @param {String} name
    *        the name of the parameter
    * @param {String} value
    *        the value of the parameter
    */
    //> public void appendParam(String name,String value);
    appendParam: function(name, value) {
            var params = this.params;
            if (!params[name]) {
                params[name] = value;
            } else if (typeof (params[name]) === 'object') {
                params[name].push(value);
            } else {
                params[name] = [params[name], value];
            }
        },

    /**
    * Adds all paramters from a parameter array to this buider's internal
    * paramter array, which is used to build the uri.
    * <p>
    * Notes: This will not overwrite the existing paramters. If the paramters
    * are duplicate with the existing one, the value will be appended as an
    * other value of the same paramter name.
    *
    * @param {Object} params
    *        the custom parameter array from which the parameter will be added
    *        to the builder's internal array
    */
    //> public void appendParams(Object);
    appendParams: function(params) {
            for (var name in params) {
                var param = params[name];
                if (typeof (param) !== 'object') {
                    this.appendParam(name, param);
                }
                else {
                    for (var idx = 0; idx < param.length; idx++) {
                        this.appendParam(name, param[idx]);
                    }
                }
            }
        },

    /**
    * Parses the paramters from the query string to the builder's internal
    * parameter array.
    *
    * @param {String} query
    *        the qurey string to be parsed
    */
    //> public void decodeParams(String);
    decodeParams: function(query) {

        var pairs = (query) ? query.split('&') : [];
        for (var idx = 0; idx < pairs.length; idx++) {

            var pair = pairs[idx].split('='), name = decodeParam(pair[0]);
            var value = (pair.length > 1) ? decodeParam(pair[1].replace(/\+/g, '%20')) : '';

            if (name) {
                this.appendParam(name, value);
            }
        }

    },

    encodeParam: function(name, value) {
            var param = encodeParam(name);
            return value ? param.concat('=', encodeParam(value)) : param;
        },

    /**
    * Builds the qurey string from a parameter array.
    *
    * @param {Object} params
    *        a specified parameter array. This function will use the builder's
    *        internal parameter array if you leave this parameter as
    *        <code>null</code>
    * @String {String}
    *        the combined query string
    */
    //> public String encodeParams(Object);
    encodeParams: function(params) { // jshint ignore:line

        var self = this, pairs = [];
        params = (params) ? params : this.params;

        for (var name in params) {
            if (params.hasOwnProperty(name)) {
                if (typeof (params[name]) !== 'object') {
                    pairs.push(self.encodeParam(name, params[name]));
                } else {
                    var param = params[name], len = typeof param !== 'undefined' ? param.length : 0;
                    for (var idx = 0; idx < len; idx++) { // jshint ignore:line
                        if (params[name][idx]) {
                            pairs.push(self.encodeParam(name, params[name][idx]));
                        }
                    }
                }
            }
        }

        return pairs.join('&');

    },

    /**
    * Parses the paramters from the form element to a parameter array.
    *
    * @param {Object} form
    *        the form element to be parsed
    */
    //> public Object decodeForm(Object);
    decodeForm: function(form) { // jshint ignore:line

        var self = this, elems = form.elements, params = {};
        var idx, len;

        for (idx = 0, len = elems.length; idx < len; idx++) {
            delete self.params[elems[idx].name];
        }

        for (idx = 0, len = elems.length; idx < len; idx++) {

            var elem = elems[idx];
            if (elem.disabled) {
                continue;
            }

            var type = elem.type, name = elem.name, value = elem.value; //<String
            if (type.match(/text|hidden|textarea|password|file/)) {
                self.appendParam(name, value);
            } else if (type.match(/radio|checkbox/) && elem.checked) {
                self.appendParam(name, value);
            }
            else if (type.match(/select-one|select-multiple/)) {
                self.appendSelect(elem);
            }

            params[name] = self.params[name];

        }

        return params;

    },

    /**
    * Gets the options from a select HTML control to a parameter array.
    *
    * @param {Object} select
    *        the select HTML control to be parsed
    */
    //> public void appendSelect(Object, Object);
    appendSelect: function(select) {
        var options = select.options;
        for (var idx = 0, len = options.length; idx < len; idx++) {
            if (options[idx].selected) {
                this.appendParam(select.name, options[idx].value);
            }
        }
    },

    /**
    * Gets the combined uri from the known information.
    *
    * @return {String}
    *         the combined uri string
    */
    //> public String getUrl();
    getUrl: function() { // jshint ignore:line

        var self = this;
        var url = (self.protocol) ? self.protocol.concat('://') : '';

        if (self.host) {
            url = url.concat(self.host);
        }
        if (self.port) {
            url = url.concat(':', self.port);
        }
        if (self.href) {
            url = url.concat(encodeUri(self.href));
        }
        if (self.isapi) {
            url = url.concat('?', self.isapi);
        }

        var query = self.encodeParams(self.params);
        if (query) {
            url = url.concat(self.isapi ? '&' : '?', query);
        }
        if (self.hash) {
            url = url.concat('#', self.hash);
        }

        return url;

    }

});

Uri.create = function(href) {
        return new Uri(href);
    };

module.exports = Uri;

});
$_mod.def("/site-speed-ebay$4.0.3/client/metrics", function(require, exports, module, __filename, __dirname) { 'use strict';
var subscriber = require('/raptor-pubsub$1.0.5/lib/index'/*'raptor-pubsub'*/).channel('site-speed-ebay');

module.exports = function metrics() {
    var _metrics = {};

    subscriber.on('metricsData', function(data) {
        for(var key in data){
            if(key){
                _metrics[key] = data[key];
            }
        }
    });

    return {
        get: function() {
            var metricSet = _metrics;
            _metrics = {};
            return metricSet;
        }
    };
};

});
$_mod.def("/site-speed-ebay$4.0.3/client/sitespeed", function(require, exports, module, __filename, __dirname) { window.$ssg = function(gaugeInfo) { // jshint ignore:line

    var metrics = require('/site-speed-ebay$4.0.3/client/metrics'/*'./metrics'*/)();
    var Uri = require('/site-speed-ebay$4.0.3/client/uri'/*'./uri'*/);
    var ebayCookies = require('/cookies-browser$0.0.2/index'/*'cookies-browser'*/);
    var sitespeed = require('/core-site-speed-ebay$1.0.4/SiteSpeed'/*'core-site-speed-ebay'*/);

    return sitespeed(gaugeInfo, Uri, ebayCookies, metrics);

};

});
$_mod.run("/site-speed-ebay$4.0.3/client/sitespeed");
$_mod.builtin("lasso-loader", "/lasso-loader$3.0.2/src/index");
$_mod.loaderMetadata({"font-async-observer":{"js":["/static/index-async.js"]}});
$_mod.installed("lasso-loader$3.0.2", "raptor-util", "1.1.2");
$_mod.def("/raptor-util$1.1.2/extend", function(require, exports, module, __filename, __dirname) { module.exports = function extend(target, source) { //A simple function to copy properties from one object to another
    if (!target) { //Check if a target was provided, otherwise create a new empty object to return
        target = {};
    }

    if (source) {
        for (var propName in source) {
            if (source.hasOwnProperty(propName)) { //Only look at source properties that are not inherited
                target[propName] = source[propName]; //Copy the property
            }
        }
    }

    return target;
};
});
$_mod.def("/lasso-loader$3.0.2/src/resource-loader", function(require, exports, module, __filename, __dirname) { /*
 * Copyright 2011 eBay Software Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var extend = require('/raptor-util$1.1.2/extend'/*'raptor-util/extend'*/);
var headEl;
function createEl(tagName, attributes) {
    var newEl = document.createElement(tagName);
    if (attributes) {
        extend(newEl, attributes);
    }
    return newEl;
}

function insertEl(el) {
    if (headEl == null)
    {
        headEl = document.getElementsByTagName('head')[0];
    }
    headEl.appendChild(el);
}


exports.js = function(src, callback, attributes) {

    attributes = attributes || {};

    var complete = false;
    var el;

    function success() {
        if (complete === false) {
            complete = true;
            callback();
        }
    }

    function error(err) {
        if (complete === false) {
            complete = true;
            //Let the loader module know that the resource was failed to be included
            callback(err || 'unknown error');
        }
    }

    extend(attributes, {
        type: 'text/javascript',
        src: src,
        onreadystatechange: function () {
            if (el.readyState == 'complete' || el.readyState == 'loaded') {
                success();
            }
        },

        onload: success,

        onerror: error
    });

    el = createEl('script', attributes);

    if (el.addEventListener) {
        try {
            el.addEventListener('load', function() {
                success();
            });
        } catch(e) {}
    }

    insertEl(el);
};

exports.css = function(href, callback, attributes) {

    var retries = 20;

    var complete = false;

    var el = createEl('link');

    function cleanup() {
        el.onload = null;
        el.onreadystatechange = null;
        el.onerror = null;
    }

    function isLoaded() {
        var sheets = document.styleSheets;
        for (var idx = 0, len = sheets.length; idx < len; idx++) {
            if (sheets[idx].href === href) {
                return true;
            }
        }
        return false;
    }

    function success() {
        if (complete === false) {
            complete = true;
            cleanup();
            //Let the loader module know that the resource has included successfully
            callback();
        }
    }

    function pollSuccess() {
        if (complete === false) {
            if (!isLoaded() && (retries--)) {
                return window.setTimeout(pollSuccess,10);
            }
            success();
        }
    }

    function error(err) {

        if (complete === false) {
            complete = true;
            cleanup();
            //Let the loader module know that the resource was failed to be included
            callback(err || 'unknown error');
        }
    }

    extend(el, {
        type: 'text/css',
        rel: 'stylesheet',
        href: href
    });

    if (attributes) {
        extend(el, attributes);
    }

    if (navigator.appName === 'Microsoft Internet Explorer') {
        el.onload = success;
        el.onreadystatechange = function() {
            var readyState = this.readyState;
            if ('loaded' === readyState || 'complete' === readyState) {
                success();
            }
        };
    }
    else
    {
        //For non-IE browsers we don't get the "onload" and "onreadystatechange" events...
        pollSuccess();
    }

    el.onerror = error;
    insertEl(el);
};
});
$_mod.def("/lasso-loader$3.0.2/src/index", function(require, exports, module, __filename, __dirname) { // the lasso module system exposes the module runtime through a semi-private property
var modulesRuntime = module.__runtime;

var resourceLoader = require('/lasso-loader$3.0.2/src/resource-loader'/*'./resource-loader'*/);
var EventEmitter = require('/events$1.1.1/events'/*'events'*/).EventEmitter;

var timeout = 3000;
var pending = {};
var completed = {};
var failed = {};
var emitter = new EventEmitter();

function start(resourceType, url) {

    if (!pending[url]) {
        pending[url] = true;

        var callback;

        var timeoutId = setTimeout(function() {
            callback('Timeout after ' + timeout + 'ms');
        }, timeout);

        callback = function(err) {
            if (!pending[url]) {
                // Callback was already invoked... most likely due
                // to a timeout
                return;
            }

            clearTimeout(timeoutId);

            delete pending[url];

            if (err) {
                failed[url] = err;
            } else {
                completed[url] = true;
            }

            emitter.emit(url, err, url);
        };

        resourceLoader[resourceType](url, callback);
    }
}

function load(resources, callback) {
    var errorMessages = [];
    var pendingCount = 0;
    var allProcessed = false;

    function done() {
        if (errorMessages.length) {
            callback('Failed: ' + errorMessages.join(', '));
        } else {
            callback();
        }
    }

    function listener(err, url) {
        if (err) {
            errorMessages.push(url + ' (' + err + ')');
        }

        // It's possible that the `listener` can be invoked before
        // `process(...)` functions return which can cause `done()`
        // to be called twice. We only invoke `done()` if we
        // both of the `process(...)` functions have returned.
        // See https://github.com/lasso-js/lasso-loader/issues/1
        if ((--pendingCount === 0) && allProcessed) {
            done();
        }
    }

    function process(resourceType) {
        var resourcesForType = resources[resourceType];
        if (resourcesForType) {
            for (var i=0, len=resourcesForType.length; i<len; i++) {
                var url = resourcesForType[i];
                if (failed[url]) {
                    errorMessages.push(url + ' (' + failed[url] + ')');
                } else if (!completed[url]) {
                    pendingCount++;
                    emitter.once(url, listener);
                    start(resourceType, url);
                }
            }
        }
    }

    process('css');
    process('js');

    // Set flag to indicate that we finished processing all of the css and js
    // and we're waiting to be notified when they complete.
    allProcessed = true;

    if (pendingCount === 0) {
        done();
    }
}

function _handleMissingAsync(asyncId) {
    if (asyncId.charAt(0) === '_') {
        return;
    } else {
        throw new Error('No loader metadata for ' + asyncId);
    }
}

function async(asyncId, callback) {
    // the lasso module system exposes the loader metadata through a semi-private property
    var loaderMeta = module.__loaderMetadata;

    var resources;

    if (!loaderMeta) {
        return callback();
    }

    if (Array.isArray(asyncId)) {
        resources = {
            js: [],
            css: []
        };
        asyncId.forEach(function(asyncId) {
            var curResources = loaderMeta[asyncId];
            if (curResources) {
                ['js', 'css'].forEach(function(key) {
                    var paths = curResources[key];
                    if (paths) {
                        resources[key] = resources[key].concat(paths);
                    }
                });
            } else {
                _handleMissingAsync(asyncId);
            }
        });
    } else if (!(resources = loaderMeta[asyncId])) {
        _handleMissingAsync(asyncId);
        return callback();
    }

    // Create a pending job in the module runtime system which will
    // prevent any "require-run" modules from running if they are
    // configured to wait until ready.
    // When all pending jobs are completed, the "require-run" modules
    // that have been queued up will be ran.
    var job = modulesRuntime.pending();

    load(resources, function(err, result) {
        // Trigger "ready" event in modules runtime to trigger running
        // require-run modules that were loaded asynchronously.
        // Let the module system know that we are done with pending job
        // of loading modules
        job.done(err);

        callback(err, result);
    });
}

exports.setTimeout = function(_timeout) {
    timeout = _timeout;
};

exports.load = load;
exports.async = async;
});
$_mod.def("/ebay-font$1.1.5/font/marketsans/fontloader", function(require, exports, module, __filename, __dirname) { /* global FontFaceObserver, Promise */
'use strict';

var lassoLoader = require('/lasso-loader$3.0.2/src/index'/*'lasso-loader'*/).async;

var fontFaceSet = document.fonts;
var FONT_CLASS_NAME = 'font-marketsans';

function updateLocalStorage() {
    try {
        localStorage.setItem('ebay-font', FONT_CLASS_NAME);
    } catch (ex) {
        // Either localStorage not present or quota has exceeded
        // Another reason Safari private mode
        // https://stackoverflow.com/questions/14555347/html5-localstorage-error-with-safari-quota-exceeded-err-dom-exception-22-an
    }
}

/**
   * Check if FontFaceSet API is supported, along with some browser quirks
   * Mainly return false if the browser has the Safari 10 bugs. The
   * native font load API in Safari 10 has two bugs that cause
   * the document.fonts.load and FontFace.prototype.load methods
   * to return promises that don't reliably get fired.
   *
   * The bugs are described in more detail here:
   *  - https://bugs.webkit.org/show_bug.cgi?id=165037
   *  - https://bugs.webkit.org/show_bug.cgi?id=164902
   *
   * If the browser is made by Apple, and has native font
   * loading support, it is potentially affected. But the API
   * was fixed around AppleWebKit version 603, so any newer
   * versions that that does not contain the bug.
   *
   * @return {boolean}
*/
function isFontFaceSetCompatible() {
    var compatible = fontFaceSet && fontFaceSet.load;
    if (compatible && /Apple/.test(window.navigator.vendor)) {
        var match = /AppleWebKit\/([0-9]+)(?:\.([0-9]+))(?:\.([0-9]+))/.exec(window.navigator.userAgent);
        compatible = !(match && parseInt(match[1], 10) < 603);
    }
    return compatible;
}

function loadFont() {
    // check for fontfaceset else load polyfill before invoking fontloader
    if (isFontFaceSetCompatible()) {
        fontFaceSet.load('1em Market Sans');
        fontFaceSet.load('bold 1em Market Sans');
        fontFaceSet.ready.then(updateLocalStorage);
    } else {
        lassoLoader('font-async-observer', function(err) {
            if (err) {
                return;
            }
            var marketsansRegular = new FontFaceObserver('Market Sans');
            var marketsansBold = new FontFaceObserver('Market Sans', { weight: 'bold' });
            Promise.all([marketsansRegular.load(), marketsansBold.load()]).then(updateLocalStorage);
        });
    }
}

function isFontLoaded() {
    return (('fontDisplay' in document.documentElement.style) ||
        (localStorage && localStorage.getItem('ebay-font') === FONT_CLASS_NAME));
}

function init() {
    // Initialize font loader only if it is not loaded previously
    if (!isFontLoaded()) {
        window.addEventListener('load', function() {
            if (requestAnimationFrame) {
                requestAnimationFrame(loadFont);
            } else {
                loadFont();
            }
        });
    }
}
init();

});
$_mod.run("/ebay-font$1.1.5/font/marketsans/fontloader");
$_mod.installed("myebaynode$1.0.0", "site-speed-above-the-fold-timer", "0.0.4");
$_mod.main("/site-speed-above-the-fold-timer$0.0.4", "");
$_mod.installed("site-speed-above-the-fold-timer$0.0.4", "raptor-pubsub", "1.0.5");
$_mod.def("/site-speed-above-the-fold-timer$0.0.4/lib/index", function(require, exports, module, __filename, __dirname) {     'use strict';
    var docElem = document.documentElement;
    var imagesTobeMeasured = 4;
    function windowScrollTop() {
        var scrollTop = window.scrollY || window.pageYOffset || docElem.scrollTop;
        return scrollTop;
    }
    function windowScrollLeft() {
        var scrollLeft = window.scrollX || window.pageXOffset || docElem.scrollLeft;
        return scrollLeft;
    }
    function windowHeight() {
        var winHeight = window.innerHeight || docElem.clientHeight || document.body.clientHeight;
        return winHeight;
    }
    function windowWidth() {
        var winWidth = window.innerWidth || docElem.clientWidth || document.body.clientWidth;
        return winWidth;
    }
    function getWindowScrollPosition() {
        return {
            top: windowScrollTop() + windowHeight(),
            left: windowScrollLeft() + windowWidth()
        };
    }
    function getImagePosition(e) {
        var pos = e.getBoundingClientRect();
        return {
            top: windowScrollTop() + pos.top,
            left: windowScrollLeft() + pos.left
        };
    }
    function calculateATF() {
        var images = document.querySelectorAll('img[data-atftimer]');
        var newCompletedAt;
        var oldCompletedAt;
        var windowPosition = getWindowScrollPosition();
        var i = 0;
        var timing = getTiming();
        var newAtf = 0;
        imagesTobeMeasured = (window.SRP && window.SRP.ATF_IMGS) || 4;
        Array.prototype.forEach.call(images, function (image) {
            var imagePosition = getImagePosition(image);
            var imageLoadTime = image.getAttribute('data-atftimer');
            if (imagePosition.top > windowScrollTop() && imagePosition.top < windowPosition.top && imagePosition.left > windowScrollLeft() && imagePosition.left < windowPosition.left) {
                if (!newCompletedAt) {
                    newCompletedAt = imageLoadTime;
                } else if (newCompletedAt < imageLoadTime) {
                    newCompletedAt = imageLoadTime;
                }
            }
            //existing approach
            if (i < imagesTobeMeasured) {
                if (!oldCompletedAt) {
                    oldCompletedAt = imageLoadTime;
                } else if (oldCompletedAt < imageLoadTime) {
                    oldCompletedAt = imageLoadTime;
                }
            }
            i++;
        });
        if (timing) {
            newAtf = oldCompletedAt - timing.responseStart;
        }
        return {
            'i_25i': newCompletedAt - $ssgST,
            'jsljgr2': oldCompletedAt - $ssgST,
            'i_29i': newAtf,
            'i_atf': newAtf
        };

    }
    function sendAtfBeacon() {
        var pubsub = require('/raptor-pubsub$1.0.5/lib/index'/*'raptor-pubsub'*/).channel('site-speed-ebay');
        pubsub.emit('metricsData', calculateATF());
    }

    function _init() {
        addEventListener('load', sendAtfBeacon, false);
    }

    function getTiming() {
        return window.performance && window.performance.timing;
    }
    _init();

});
$_mod.def("/site-speed-above-the-fold-timer$0.0.4/lib/init", function(require, exports, module, __filename, __dirname) { require('/site-speed-above-the-fold-timer$0.0.4/lib/index'/*'./index'*/);
});
$_mod.run("/site-speed-above-the-fold-timer$0.0.4/lib/init",{"wait":false});
$_mod.main("/site-speed-above-the-fold-timer$0.0.4/lib", "");
$_mod.def("/site-speed-above-the-fold-timer$0.0.4/index", function(require, exports, module, __filename, __dirname) { module = module.exports = require('/site-speed-above-the-fold-timer$0.0.4/lib/index'/*'./lib'*/);
});
$_mod.installed("myebaynode$1.0.0", "marko", "4.4.28");
$_mod.main("/marko$4.4.28/src/runtime/vdom", "");
$_mod.main("/marko$4.4.28/src", "");
$_mod.remap("/marko$4.4.28/src/index", "/marko$4.4.28/src/index-browser");
$_mod.def("/marko$4.4.28/src/runtime/createOut", function(require, exports, module, __filename, __dirname) { var actualCreateOut;

function setCreateOut(createOutFunc) {
    actualCreateOut = createOutFunc;
}

function createOut(globalData) {
    return actualCreateOut(globalData);
}

createOut.___setCreateOut = setCreateOut;

module.exports = createOut;
});
$_mod.main("/marko$4.4.28/src/loader", "");
$_mod.remap("/marko$4.4.28/src/loader/index", "/marko$4.4.28/src/loader/index-browser");
$_mod.remap("/marko$4.4.28/src/loader/index-browser", "/marko$4.4.28/src/loader/index-browser-dynamic");
$_mod.def("/marko$4.4.28/src/loader/index-browser-dynamic", function(require, exports, module, __filename, __dirname) { 'use strict';
module.exports = function load(templatePath) {
    // We make the assumption that the template path is a
    // fully resolved module path and that the module exists
    // as a CommonJS module
    return require(templatePath);
};
});
$_mod.def("/marko$4.4.28/src/index-browser", function(require, exports, module, __filename, __dirname) { 'use strict';
exports.createOut = require('/marko$4.4.28/src/runtime/createOut'/*'./runtime/createOut'*/);
exports.load = require('/marko$4.4.28/src/loader/index-browser-dynamic'/*'./loader'*/);

});
$_mod.installed("marko$4.4.28", "events-light", "1.0.5");
$_mod.main("/events-light$1.0.5", "src/index");
$_mod.def("/events-light$1.0.5/src/index", function(require, exports, module, __filename, __dirname) { /* jshint newcap:false */
var slice = Array.prototype.slice;

function isFunction(arg) {
    return typeof arg === 'function';
}

function checkListener(listener) {
    if (!isFunction(listener)) {
        throw TypeError('Invalid listener');
    }
}

function invokeListener(ee, listener, args) {
    switch (args.length) {
        // fast cases
        case 1:
            listener.call(ee);
            break;
        case 2:
            listener.call(ee, args[1]);
            break;
        case 3:
            listener.call(ee, args[1], args[2]);
            break;
            // slower
        default:
            listener.apply(ee, slice.call(args, 1));
    }
}

function addListener(eventEmitter, type, listener, prepend) {
    checkListener(listener);

    var events = eventEmitter.$e || (eventEmitter.$e = {});

    var listeners = events[type];
    if (listeners) {
        if (isFunction(listeners)) {
            events[type] = prepend ? [listener, listeners] : [listeners, listener];
        } else {
            if (prepend) {
                listeners.unshift(listener);
            } else {
                listeners.push(listener);
            }
        }

    } else {
        events[type] = listener;
    }
    return eventEmitter;
}

function EventEmitter() {
    this.$e = this.$e || {};
}

EventEmitter.EventEmitter = EventEmitter;

EventEmitter.prototype = {
    $e: null,

    emit: function(type) {
        var args = arguments;

        var events = this.$e;
        if (!events) {
            return;
        }

        var listeners = events && events[type];
        if (!listeners) {
            // If there is no 'error' event listener then throw.
            if (type === 'error') {
                var error = args[1];
                if (!(error instanceof Error)) {
                    var context = error;
                    error = new Error('Error: ' + context);
                    error.context = context;
                }

                throw error; // Unhandled 'error' event
            }

            return false;
        }

        if (isFunction(listeners)) {
            invokeListener(this, listeners, args);
        } else {
            listeners = slice.call(listeners);

            for (var i=0, len=listeners.length; i<len; i++) {
                var listener = listeners[i];
                invokeListener(this, listener, args);
            }
        }

        return true;
    },

    on: function(type, listener) {
        return addListener(this, type, listener, false);
    },

    prependListener: function(type, listener) {
        return addListener(this, type, listener, true);
    },

    once: function(type, listener) {
        checkListener(listener);

        function g() {
            this.removeListener(type, g);

            if (listener) {
                listener.apply(this, arguments);
                listener = null;
            }
        }

        this.on(type, g);

        return this;
    },

    // emits a 'removeListener' event iff the listener was removed
    removeListener: function(type, listener) {
        checkListener(listener);

        var events = this.$e;
        var listeners;

        if (events && (listeners = events[type])) {
            if (isFunction(listeners)) {
                if (listeners === listener) {
                    delete events[type];
                }
            } else {
                for (var i=listeners.length-1; i>=0; i--) {
                    if (listeners[i] === listener) {
                        listeners.splice(i, 1);
                    }
                }
            }
        }

        return this;
    },

    removeAllListeners: function(type) {
        var events = this.$e;
        if (events) {
            delete events[type];
        }
    },

    listenerCount: function(type) {
        var events = this.$e;
        var listeners = events && events[type];
        return listeners ? (isFunction(listeners) ? 1 : listeners.length) : 0;
    }
};

module.exports = EventEmitter;
});
$_mod.def("/marko$4.4.28/src/morphdom/specialElHandlers", function(require, exports, module, __filename, __dirname) { function syncBooleanAttrProp(fromEl, toEl, name) {
    if (fromEl[name] !== toEl[name]) {
        fromEl[name] = toEl[name];
        if (fromEl[name]) {
            fromEl.setAttribute(name, '');
        } else {
            fromEl.removeAttribute(name, '');
        }
    }
}

module.exports = {
    /**
     * Needed for IE. Apparently IE doesn't think that "selected" is an
     * attribute when reading over the attributes using selectEl.attributes
     */
    OPTION: function(fromEl, toEl) {
        syncBooleanAttrProp(fromEl, toEl, 'selected');
    },
    /**
     * The "value" attribute is special for the <input> element since it sets
     * the initial value. Changing the "value" attribute without changing the
     * "value" property will have no effect since it is only used to the set the
     * initial value.  Similar for the "checked" attribute, and "disabled".
     */
    INPUT: function(fromEl, toEl) {
        syncBooleanAttrProp(fromEl, toEl, 'checked');
        syncBooleanAttrProp(fromEl, toEl, 'disabled');

        if (fromEl.value != toEl.value) {
            fromEl.value = toEl.value;
        }

        if (!toEl.___hasAttribute('value')) {
            fromEl.removeAttribute('value');
        }
    },

    TEXTAREA: function(fromEl, toEl) {
        var newValue = toEl.value;
        if (fromEl.value != newValue) {
            fromEl.value = newValue;
        }

        var firstChild = fromEl.firstChild;
        if (firstChild) {
            // Needed for IE. Apparently IE sets the placeholder as the
            // node value and vise versa. This ignores an empty update.
            var oldValue = firstChild.nodeValue;

            if (oldValue == newValue || (!newValue && oldValue == fromEl.placeholder)) {
                return;
            }

            firstChild.nodeValue = newValue;
        }
    },
    SELECT: function(fromEl, toEl) {
        if (!toEl.___hasAttribute('multiple')) {
            var selectedIndex = -1;
            var i = 0;
            var curChild = toEl.___firstChild;
            while(curChild) {
                if (curChild.___nodeName == 'OPTION') {
                    if (curChild.___hasAttribute('selected')) {
                        selectedIndex = i;
                        break;
                    }
                    i++;
                }
                curChild = curChild.___nextSibling;
            }

            fromEl.selectedIndex = i;
        }
    }
};

});
$_mod.def("/marko$4.4.28/src/runtime/vdom/VNode", function(require, exports, module, __filename, __dirname) { /* jshint newcap:false */
var specialElHandlers = require('/marko$4.4.28/src/morphdom/specialElHandlers'/*'../../morphdom/specialElHandlers'*/);

function VNode() {}

VNode.prototype = {
    ___VNode: function(finalChildCount) {
        this.___finalChildCount = finalChildCount;
        this.___childCount = 0;
        this.___firstChildInternal = null;
        this.___lastChild = null;
        this.___parentNode = null;
        this.___nextSiblingInternal = null;
    },

    get ___firstChild() {
        var firstChild = this.___firstChildInternal;

        if (firstChild && firstChild.___DocumentFragment) {
            var nestedFirstChild = firstChild.___firstChild;
            // The first child is a DocumentFragment node.
            // If the DocumentFragment node has a first child then we will return that.
            // Otherwise, the DocumentFragment node is not *really* the first child and
            // we need to skip to its next sibling
            return nestedFirstChild || firstChild.___nextSibling;
        }

        return firstChild;
    },

    get ___nextSibling() {
        var nextSibling = this.___nextSiblingInternal;

        if (nextSibling) {
            if (nextSibling.___DocumentFragment) {
                var firstChild = nextSibling.___firstChild;
                return firstChild || nextSibling.___nextSibling;
            }
        } else {
            var parentNode = this.___parentNode;
            if (parentNode && parentNode.___DocumentFragment) {
                return parentNode.___nextSibling;
            }
        }

        return nextSibling;
    },

    ___appendChild: function(child) {
        this.___childCount++;

        if (this.___isTextArea) {
            if (child.___Text) {
                var childValue = child.___nodeValue;
                this.___value = (this.___value || '') + childValue;
            } else {
                throw TypeError();
            }
        } else {
            var lastChild = this.___lastChild;

            child.___parentNode = this;

            if (lastChild) {
                lastChild.___nextSiblingInternal = child;
            } else {
                this.___firstChildInternal = child;
            }

            this.___lastChild = child;
        }

        return child;
    },

    ___finishChild: function finishChild() {
        if (this.___childCount == this.___finalChildCount && this.___parentNode) {
            return this.___parentNode.___finishChild();
        } else {
            return this;
        }
    },

    actualize: function(doc) {
        var actualNode = this.___actualize(doc);

        var curChild = this.___firstChild;

        while(curChild) {
            actualNode.appendChild(curChild.actualize(doc));
            curChild = curChild.___nextSibling;
        }

        if (this.___nodeType === 1) {
            var elHandler = specialElHandlers[this.___nodeName];
            if (elHandler !== undefined) {
                elHandler(actualNode, this);
            }
        }

        return actualNode;
    }

    // ,toJSON: function() {
    //     var clone = Object.assign({
    //         nodeType: this.nodeType
    //     }, this);
    //
    //     for (var k in clone) {
    //         if (k.startsWith('_')) {
    //             delete clone[k];
    //         }
    //     }
    //     delete clone._nextSibling;
    //     delete clone._lastChild;
    //     delete clone.parentNode;
    //     return clone;
    // }
};

module.exports = VNode;

});
$_mod.installed("marko$4.4.28", "raptor-util", "3.2.0");
$_mod.def("/marko$4.4.28/src/runtime/vdom/VComment", function(require, exports, module, __filename, __dirname) { var VNode = require('/marko$4.4.28/src/runtime/vdom/VNode'/*'./VNode'*/);
var inherit = require('/raptor-util$3.2.0/inherit'/*'raptor-util/inherit'*/);

function VComment(value) {
    this.___VNode(-1 /* no children */);
    this.___nodeValue = value;
}

VComment.prototype = {
    ___nodeType: 8,

    ___actualize: function(doc) {
        return doc.createComment(this.___nodeValue);
    },

    ___cloneNode: function() {
        return new VComment(this.___nodeValue);
    }
};

inherit(VComment, VNode);

module.exports = VComment;

});
$_mod.def("/marko$4.4.28/src/runtime/vdom/VDocumentFragment", function(require, exports, module, __filename, __dirname) { var VNode = require('/marko$4.4.28/src/runtime/vdom/VNode'/*'./VNode'*/);
var inherit = require('/raptor-util$3.2.0/inherit'/*'raptor-util/inherit'*/);
var extend = require('/raptor-util$3.2.0/extend'/*'raptor-util/extend'*/);

function VDocumentFragmentClone(other) {
    extend(this, other);
    this.___parentNode = null;
    this.___nextSiblingInternal = null;
}

function VDocumentFragment(documentFragment) {
    this.___VNode(null /* childCount */);
}

VDocumentFragment.prototype = {
    ___nodeType: 11,

    ___DocumentFragment: true,

    ___cloneNode: function() {
        return new VDocumentFragmentClone(this);
    },

    ___actualize: function(doc) {
        return doc.createDocumentFragment();
    }
};

inherit(VDocumentFragment, VNode);

VDocumentFragmentClone.prototype = VDocumentFragment.prototype;

module.exports = VDocumentFragment;

});
$_mod.def("/marko$4.4.28/src/runtime/vdom/VElement", function(require, exports, module, __filename, __dirname) { var VNode = require('/marko$4.4.28/src/runtime/vdom/VNode'/*'./VNode'*/);
var inherit = require('/raptor-util$3.2.0/inherit'/*'raptor-util/inherit'*/);

var NS_XLINK = 'http://www.w3.org/1999/xlink';
var ATTR_XLINK_HREF = 'xlink:href';
var toString = String;

var FLAG_IS_SVG = 1;
var FLAG_IS_TEXTAREA = 2;
var FLAG_SIMPLE_ATTRS = 4;

var defineProperty = Object.defineProperty;

var ATTR_HREF = 'href';
var EMPTY_OBJECT = Object.freeze({});

function convertAttrValue(type, value) {
    if (value === true) {
        return '';
    } else if (type == 'object') {
        return JSON.stringify(value);
    } else {
        return toString(value);
    }
}

function setAttribute(el, namespaceURI, name, value) {
    if (namespaceURI === null) {
        el.setAttribute(name, value);
    } else {
        el.setAttributeNS(namespaceURI, name, value);
    }
}

function removeAttribute(el, namespaceURI, name) {
    if (namespaceURI === null) {
        el.removeAttribute(name);
    } else {
        el.removeAttributeNS(namespaceURI, name);
    }
}

function VElementClone(other) {
    this.___firstChildInternal = other.___firstChildInternal;
    this.___parentNode = null;
    this.___nextSiblingInternal = null;

    this.___attributes = other.___attributes;
    this.___properties = other.___properties;
    this.___namespaceURI = other.___namespaceURI;
    this.___nodeName = other.___nodeName;
    this.___flags = other.___flags;
    this.___value = other.___value;
    this.___constId = other.___constId;
}

function VElement(tagName, attrs, childCount, flags, props) {
    this.___VNode(childCount);

    var constId, namespaceURI;

    if (props) {
        constId = props.c;
    }

    if ((this.___flags = flags || 0)) {
        if (flags & FLAG_IS_SVG) {
            namespaceURI = 'http://www.w3.org/2000/svg';
        }
    }

    this.___attributes = attrs || EMPTY_OBJECT;
    this.___properties = props || EMPTY_OBJECT;
    this.___namespaceURI = namespaceURI;
    this.___nodeName = tagName;
    this.___value = null;
    this.___constId = constId;
}

VElement.prototype = {
    ___VElement: true,

    ___nodeType: 1,

    ___cloneNode: function() {
        return new VElementClone(this);
    },

    /**
     * Shorthand method for creating and appending an HTML element
     *
     * @param  {String} tagName    The tag name (e.g. "div")
     * @param  {int|null} attrCount  The number of attributes (or `null` if not known)
     * @param  {int|null} childCount The number of child nodes (or `null` if not known)
     */
    e: function(tagName, attrs, childCount, flags, props) {
        var child = this.___appendChild(new VElement(tagName, attrs, childCount, flags, props));

        if (childCount === 0) {
            return this.___finishChild();
        } else {
            return child;
        }
    },

    /**
     * Shorthand method for creating and appending an HTML element with a dynamic namespace
     *
     * @param  {String} tagName    The tag name (e.g. "div")
     * @param  {int|null} attrCount  The number of attributes (or `null` if not known)
     * @param  {int|null} childCount The number of child nodes (or `null` if not known)
     */
    ed: function(tagName, attrs, childCount, flags, props) {
        var child = this.___appendChild(VElement.___createElementDynamicTag(tagName, attrs, childCount, flags, props));

        if (childCount === 0) {
            return this.___finishChild();
        } else {
            return child;
        }
    },

    /**
     * Shorthand method for creating and appending a static node. The provided node is automatically cloned
     * using a shallow clone since it will be mutated as a result of setting `nextSibling` and `parentNode`.
     *
     * @param  {String} value The value for the new Comment node
     */
    n: function(node) {
        this.___appendChild(node.___cloneNode());
        return this.___finishChild();
    },

    ___actualize: function(doc) {
        var namespaceURI = this.___namespaceURI;
        var tagName = this.___nodeName;

        var attributes = this.___attributes;
        var flags = this.___flags;

        var el = namespaceURI !== undefined ?
            doc.createElementNS(namespaceURI, tagName) :
            doc.createElement(tagName);

        for (var attrName in attributes) {
            var attrValue = attributes[attrName];

            if (attrValue !== false && attrValue != null) {
                var type = typeof attrValue;

                if (type !== 'string') {
                    // Special attributes aren't copied to the real DOM. They are only
                    // kept in the virtual attributes map
                    attrValue = convertAttrValue(type, attrValue);
                }

                if (attrName == ATTR_XLINK_HREF) {
                    setAttribute(el, NS_XLINK, ATTR_HREF, attrValue);
                } else {
                    el.setAttribute(attrName, attrValue);
                }
            }
        }

        if (flags & FLAG_IS_TEXTAREA) {
            el.value = this.___value;
        }

        el._vattrs = attributes;
        el._vprops = this.___properties;
        el._vflags = flags;

        return el;
    },

    ___hasAttribute: function(name) {
        // We don't care about the namespaces since the there
        // is no chance that attributes with the same name will have
        // different namespaces
        var value = this.___attributes[name];
        return value != null && value !== false;
    },
};

inherit(VElement, VNode);

var proto = VElementClone.prototype = VElement.prototype;

['checked', 'selected', 'disabled'].forEach(function(name) {
    defineProperty(proto, name, {
        get: function () {
            var value = this.___attributes[name];
            return value !== false && value != null;
        }
    });
});

defineProperty(proto, 'id', {
    get: function () {
        return this.___attributes.id;
    }
});

defineProperty(proto, 'value', {
    get: function () {
        var value = this.___value;
        if (value == null) {
            value = this.___attributes.value;
        }
        return value != null ? toString(value) : '';
    }
});

defineProperty(proto, '___isTextArea', {
    get: function () {
        return this.___flags & FLAG_IS_TEXTAREA;
    }
});

VElement.___createElementDynamicTag = function(tagName, attrs, childCount, flags, props) {
    var namespace = attrs && attrs.xmlns;
    tagName = namespace ? tagName : tagName.toUpperCase();
    var element = new VElement(tagName, attrs, childCount, flags, props);
    element.___namespaceURI = namespace;
    return element;
};

VElement.___removePreservedAttributes = function(attrs) {
    // By default this static method is a no-op, but if there are any
    // compiled components that have "no-update" attributes then
    // `preserve-attrs.js` will be imported and this method will be replaced
    // with a method that actually does something
    return attrs;
};

VElement.___morphAttrs = function(fromEl, toEl) {

    var removePreservedAttributes = VElement.___removePreservedAttributes;

    var attrs = toEl.___attributes;
    var props = fromEl._vprops = toEl.___properties;

    var attrName;
    var i;

    // We use expando properties to associate the previous HTML
    // attributes provided as part of the VDOM node with the
    // real VElement DOM node. When diffing attributes,
    // we only use our internal representation of the attributes.
    // When diffing for the first time it's possible that the
    // real VElement node will not have the expando property
    // so we build the attribute map from the expando property

    var oldAttrs = fromEl._vattrs;

    if (oldAttrs) {
        if (oldAttrs == attrs) {
            // For constant attributes the same object will be provided
            // every render and we can use that to our advantage to
            // not waste time diffing a constant, immutable attribute
            // map.
            return;
        } else {
            oldAttrs = removePreservedAttributes(oldAttrs, props, true);
        }
    } else {
        // We need to build the attribute map from the real attributes
        oldAttrs = {};

        var oldAttributesList = fromEl.attributes;
        for (i = oldAttributesList.length - 1; i >= 0; --i) {
            var attr = oldAttributesList[i];

            if (attr.specified !== false) {
                attrName = attr.name;
                if (attrName !== 'data-marko') {
                    var attrNamespaceURI = attr.namespaceURI;
                    if (attrNamespaceURI === NS_XLINK) {
                        oldAttrs[ATTR_XLINK_HREF] = attr.value;
                    } else {
                        oldAttrs[attrName] = attr.value;
                    }
                }
            }
        }

        // We don't want preserved attributes to show up in either the old
        // or new attribute map.
        removePreservedAttributes(oldAttrs, props, false);
    }

    fromEl._vattrs = attrs;

    var attrValue;

    var flags = toEl.___flags;
    var oldFlags;

    if (flags & FLAG_SIMPLE_ATTRS && ((oldFlags = fromEl._vflags) & FLAG_SIMPLE_ATTRS)) {
        if (oldAttrs['class'] !== (attrValue = attrs['class'])) {
            fromEl.className = attrValue;
        }
        if (oldAttrs.id !== (attrValue = attrs.id)) {
            fromEl.id = attrValue;
        }
        if (oldAttrs.style !== (attrValue = attrs.style)) {
            fromEl.style.cssText = attrValue;
        }
        return;
    }

    // In some cases we only want to set an attribute value for the first
    // render or we don't want certain attributes to be touched. To support
    // that use case we delete out all of the preserved attributes
    // so it's as if they never existed.
    attrs = removePreservedAttributes(attrs, props, true);

    var namespaceURI;

    // Loop over all of the attributes in the attribute map and compare
    // them to the value in the old map. However, if the value is
    // null/undefined/false then we want to remove the attribute
    for (attrName in attrs) {
        attrValue = attrs[attrName];
        namespaceURI = null;

        if (attrName === ATTR_XLINK_HREF) {
            namespaceURI = NS_XLINK;
            attrName = ATTR_HREF;
        }

        if (attrValue == null || attrValue === false) {
            removeAttribute(fromEl, namespaceURI, attrName);
        } else if (oldAttrs[attrName] !== attrValue) {
            var type = typeof attrValue;

            if (type !== 'string') {
                attrValue = convertAttrValue(type, attrValue);
            }

            setAttribute(fromEl, namespaceURI, attrName, attrValue);
        }
    }

    // If there are any old attributes that are not in the new set of attributes
    // then we need to remove those attributes from the target node
    //
    // NOTE: We can skip this if the the element is keyed because if the element
    //       is keyed then we know we already processed all of the attributes for
    //       both the target and original element since target VElement nodes will
    //       have all attributes declared. However, we can only skip if the node
    //       was not a virtualized node (i.e., a node that was not rendered by a
    //       Marko template, but rather a node that was created from an HTML
    //       string or a real DOM node).
    if (!attrs.id || props.___virtualized === true) {
        for (attrName in oldAttrs) {
            if (!(attrName in attrs)) {
                if (attrName === ATTR_XLINK_HREF) {
                    fromEl.removeAttributeNS(ATTR_XLINK_HREF, ATTR_HREF);
                } else {
                    fromEl.removeAttribute(attrName);
                }
            }
        }
    }
};

module.exports = VElement;

});
$_mod.def("/marko$4.4.28/src/runtime/vdom/VText", function(require, exports, module, __filename, __dirname) { var VNode = require('/marko$4.4.28/src/runtime/vdom/VNode'/*'./VNode'*/);
var inherit = require('/raptor-util$3.2.0/inherit'/*'raptor-util/inherit'*/);

function VText(value) {
    this.___VNode(-1 /* no children */);
    this.___nodeValue = value;
}

VText.prototype = {
    ___Text: true,

    ___nodeType: 3,

    ___actualize: function(doc) {
        return doc.createTextNode(this.___nodeValue);
    },

    ___cloneNode: function() {
        return new VText(this.___nodeValue);
    }
};

inherit(VText, VNode);

module.exports = VText;

});
$_mod.def("/marko$4.4.28/src/runtime/vdom/vdom", function(require, exports, module, __filename, __dirname) { var VNode = require('/marko$4.4.28/src/runtime/vdom/VNode'/*'./VNode'*/);
var VComment = require('/marko$4.4.28/src/runtime/vdom/VComment'/*'./VComment'*/);
var VDocumentFragment = require('/marko$4.4.28/src/runtime/vdom/VDocumentFragment'/*'./VDocumentFragment'*/);
var VElement = require('/marko$4.4.28/src/runtime/vdom/VElement'/*'./VElement'*/);
var VText = require('/marko$4.4.28/src/runtime/vdom/VText'/*'./VText'*/);

var FLAG_IS_TEXTAREA = 2;
var defaultDocument = typeof document != 'undefined' && document;
var specialHtmlRegexp = /[&<]/;
var xmlnsRegExp = /^xmlns(:|$)/;
var virtualizedProps = { ___virtualized: true };

function virtualizeChildNodes(node, vdomParent) {
    var curChild = node.firstChild;
    while(curChild) {
        vdomParent.___appendChild(virtualize(curChild));
        curChild = curChild.nextSibling;
    }
}

function virtualize(node) {
    switch(node.nodeType) {
        case 1:
            var attributes = node.attributes;
            var attrCount = attributes.length;

            var attrs;

            if (attrCount) {
                attrs = {};
                for (var i=0; i<attrCount; i++) {
                    var attr = attributes[i];
                    var attrName = attr.name;
                    if (!xmlnsRegExp.test(attrName)) {
                        attrs[attrName] = attr.value;
                    }
                }
            }

            var flags = 0;

            var tagName = node.nodeName;
            if (tagName === 'TEXTAREA') {
                flags |= FLAG_IS_TEXTAREA;
            }

            var vdomEl = new VElement(tagName, attrs, null, flags, virtualizedProps);
            if (node.namespaceURI !== 'http://www.w3.org/1999/xhtml') {
                vdomEl.___namespaceURI = node.namespaceURI;
            }

            if (vdomEl.___isTextArea) {
                vdomEl.___value = node.value;
            } else {
                virtualizeChildNodes(node, vdomEl);
            }

            return vdomEl;
        case 3:
            return new VText(node.nodeValue);
        case 8:
            return new VComment(node.nodeValue);
        case 11:
            var vdomDocFragment = new VDocumentFragment();
            virtualizeChildNodes(node, vdomDocFragment);
            return vdomDocFragment;
    }
}

function virtualizeHTML(html, doc) {
    if (!specialHtmlRegexp.test(html)) {
        return new VText(html);
    }

    var container = doc.createElement('body');
    container.innerHTML = html;
    var vdomFragment = new VDocumentFragment();

    var curChild = container.firstChild;
    while(curChild) {
        vdomFragment.___appendChild(virtualize(curChild));
        curChild = curChild.nextSibling;
    }

    return vdomFragment;
}

var Node_prototype = VNode.prototype;

/**
 * Shorthand method for creating and appending a Text node with a given value
 * @param  {String} value The text value for the new Text node
 */
Node_prototype.t = function(value) {
    var type = typeof value;
    var vdomNode;

    if (type !== 'string') {
        if (value == null) {
            value = '';
        } else if (type === 'object') {
            if (value.toHTML) {
                vdomNode = virtualizeHTML(value.toHTML(), document);
            }
        }
    }

    this.___appendChild(vdomNode || new VText(value.toString()));
    return this.___finishChild();
};

/**
 * Shorthand method for creating and appending a Comment node with a given value
 * @param  {String} value The value for the new Comment node
 */
Node_prototype.c = function(value) {
    this.___appendChild(new VComment(value));
    return this.___finishChild();
};

Node_prototype.___appendDocumentFragment = function() {
    return this.___appendChild(new VDocumentFragment());
};

exports.___VComment = VComment;
exports.___VDocumentFragment = VDocumentFragment;
exports.___VElement = VElement;
exports.___VText = VText;
exports.___virtualize = virtualize;
exports.___virtualizeHTML = virtualizeHTML;
exports.___defaultDocument = defaultDocument;

});
$_mod.remap("/marko$4.4.28/src/components/util", "/marko$4.4.28/src/components/util-browser");
$_mod.remap("/marko$4.4.28/src/components/init-components", "/marko$4.4.28/src/components/init-components-browser");
$_mod.installed("marko$4.4.28", "warp10", "1.3.6");
$_mod.def("/warp10$1.3.6/src/finalize", function(require, exports, module, __filename, __dirname) { var isArray = Array.isArray;

function resolve(object, path, len) {
    var current = object;
    for (var i=0; i<len; i++) {
        current = current[path[i]];
    }

    return current;
}

function resolveType(info) {
    if (info.type === 'Date') {
        return new Date(info.value);
    } else {
        throw new Error('Bad type');
    }
}

module.exports = function finalize(outer) {
    if (!outer) {
        return outer;
    }

    var assignments = outer.$$;
    if (assignments) {
        var object = outer.o;
        var len;

        if (assignments && (len=assignments.length)) {
            for (var i=0; i<len; i++) {
                var assignment = assignments[i];

                var rhs = assignment.r;
                var rhsValue;

                if (isArray(rhs)) {
                    rhsValue = resolve(object, rhs, rhs.length);
                } else {
                    rhsValue = resolveType(rhs);
                }

                var lhs = assignment.l;
                var lhsLast = lhs.length-1;

                if (lhsLast === -1) {
                    object = outer.o = rhsValue;
                    break;
                } else {
                    var lhsParent = resolve(object, lhs, lhsLast);
                    lhsParent[lhs[lhsLast]] = rhsValue;
                }
            }
        }

        assignments.length = 0; // Assignments have been applied, do not reapply

        return object == null ? null : object;
    } else {
        return outer;
    }

};
});
$_mod.def("/warp10$1.3.6/finalize", function(require, exports, module, __filename, __dirname) { module.exports = require('/warp10$1.3.6/src/finalize'/*'./src/finalize'*/);
});
$_mod.def("/marko$4.4.28/src/components/bubble", function(require, exports, module, __filename, __dirname) { module.exports = [
    /* Mouse Events */
    'click',
    'dblclick',
    'mousedown',
    'mouseup',
    // 'mouseover',
    // 'mousemove',
    // 'mouseout',
    'dragstart',
    'drag',
    // 'dragenter',
    // 'dragleave',
    // 'dragover',
    'drop',
    'dragend',

    /* Keyboard Events */
    'keydown',
    'keypress',
    'keyup',

    /* Form Events */
    'select',
    'change',
    'submit',
    'reset',
    'input',

    'attach', // Pseudo event supported by Marko
    'detach'  // Pseudo event supported by Marko

    // 'focus', <-- Does not bubble
    // 'blur', <-- Does not bubble
    // 'focusin', <-- Not supported in all browsers
    // 'focusout' <-- Not supported in all browsers
];
});
$_mod.def("/marko$4.4.28/src/components/event-delegation", function(require, exports, module, __filename, __dirname) { var componentsUtil = require('/marko$4.4.28/src/components/util-browser'/*'./util'*/);
var runtimeId = componentsUtil.___runtimeId;
var componentLookup = componentsUtil.___componentLookup;
var getMarkoPropsFromEl = componentsUtil.___getMarkoPropsFromEl;

// We make our best effort to allow multiple marko runtimes to be loaded in the
// same window. Each marko runtime will get its own unique runtime ID.
var listenersAttachedKey = '$MED' + runtimeId;

function getEventFromEl(el, eventName) {
    var virtualProps = getMarkoPropsFromEl(el);
    var eventInfo = virtualProps[eventName];
    if (typeof eventInfo === 'string') {
        eventInfo = eventInfo.split(' ');
        if (eventInfo.length == 3) {
            eventInfo[2] = parseInt(eventInfo[2], 10);
        }
    }

    return eventInfo;
}

function delegateEvent(node, target, event) {
    var targetMethod = target[0];
    var targetComponentId = target[1];
    var extraArgs = target[2];

    var targetComponent = componentLookup[targetComponentId];

    if (!targetComponent) {
        return;
    }

    var targetFunc = targetComponent[targetMethod];
    if (!targetFunc) {
        throw Error('Method not found: ' + targetMethod);
    }

    if (extraArgs != null) {
        if (typeof extraArgs === 'number') {
            extraArgs = targetComponent.___bubblingDomEvents[extraArgs];
        }
    }

    // Invoke the component method
    if (extraArgs) {
        targetFunc.apply(targetComponent, extraArgs.concat(event, node));
    } else {
        targetFunc.call(targetComponent, event, node);
    }
}

function attachBubbleEventListeners(doc) {
    var body = doc.body;
    // Here's where we handle event delegation using our own mechanism
    // for delegating events. For each event that we have white-listed
    // as supporting bubble, we will attach a listener to the root
    // document.body element. When we get notified of a triggered event,
    // we again walk up the tree starting at the target associated
    // with the event to find any mappings for event. Each mapping
    // is from a DOM event type to a method of a component.
    require('/marko$4.4.28/src/components/bubble'/*'./bubble'*/).forEach(function addBubbleHandler(eventType) {
        body.addEventListener(eventType, function(event) {
            var propagationStopped = false;

            // Monkey-patch to fix #97
            var oldStopPropagation = event.stopPropagation;

            event.stopPropagation = function() {
                oldStopPropagation.call(event);
                propagationStopped = true;
            };

            var curNode = event.target;
            if (!curNode) {
                return;
            }

            // event.target of an SVGElementInstance does not have a
            // `getAttribute` function in IE 11.
            // See https://github.com/marko-js/marko/issues/796
            curNode = curNode.correspondingUseElement || curNode;

            // Search up the tree looking DOM events mapped to target
            // component methods
            var propName = 'on' + eventType;
            var target;

            // Attributes will have the following form:
            // on<event_type>("<target_method>|<component_id>")

            do {
                if ((target = getEventFromEl(curNode, propName))) {
                    delegateEvent(curNode, target, event);

                    if (propagationStopped) {
                        break;
                    }
                }
            } while((curNode = curNode.parentNode) && curNode.getAttribute);
        });
    });
}

function noop() {}

exports.___handleNodeAttach = noop;
exports.___handleNodeDetach = noop;
exports.___delegateEvent = delegateEvent;
exports.___getEventFromEl = getEventFromEl;

exports.___init = function(doc) {
    if (!doc[listenersAttachedKey]) {
        doc[listenersAttachedKey] = true;
        attachBubbleEventListeners(doc);
    }
};

});
$_mod.def("/marko$4.4.28/src/components/ComponentDef", function(require, exports, module, __filename, __dirname) { 'use strict';
var repeatedRegExp = /\[\]$/;
var componentUtil = require('/marko$4.4.28/src/components/util-browser'/*'./util'*/);
var attachBubblingEvent = componentUtil.___attachBubblingEvent;
var extend = require('/raptor-util$3.2.0/extend'/*'raptor-util/extend'*/);

/**
 * A ComponentDef is used to hold the metadata collected at runtime for
 * a single component and this information is used to instantiate the component
 * later (after the rendered HTML has been added to the DOM)
 */
function ComponentDef(component, componentId, globalComponentsContext, componentStack, componentStackLen) {
    this.___globalComponentsContext = globalComponentsContext; // The AsyncWriter that this component is associated with
    this.___componentStack = componentStack;
    this.___componentStackLen = componentStackLen;
    this.___component = component;
    this.id = componentId;

    this.___roots =  null;            // IDs of root elements if there are multiple root elements
    this.___children = null;          // An array of nested ComponentDef instances
    this.___domEvents = undefined;         // An array of DOM events that need to be added (in sets of three)

    this.___isExisting = false;

    this.___willRerenderInBrowser = false;

    this.___nextIdIndex = 0; // The unique integer to use for the next scoped ID
}

ComponentDef.prototype = {
    ___end: function() {
        this.___componentStack.length = this.___componentStackLen;
    },

    /**
     * Register a nested component for this component. We maintain a tree of components
     * so that we can instantiate nested components before their parents.
     */
    ___addChild: function (componentDef) {
        var children = this.___children;

        if (children) {
            children.push(componentDef);
        } else {
            this.___children = [componentDef];
        }
    },
    /**
     * This helper method generates a unique and fully qualified DOM element ID
     * that is unique within the scope of the current component. This method prefixes
     * the the nestedId with the ID of the current component. If nestedId ends
     * with `[]` then it is treated as a repeated ID and we will generate
     * an ID with the current index for the current nestedId.
     * (e.g. "myParentId-foo[0]", "myParentId-foo[1]", etc.)
     */
    elId: function (nestedId) {
        var id = this.id;
        if (nestedId == null) {
            return id;
        } else {
            if (typeof nestedId == 'string' && repeatedRegExp.test(nestedId)) {
                return this.___globalComponentsContext.___nextRepeatedId(id, nestedId);
            } else {
                return id + '-' + nestedId;
            }
        }
    },
    /**
     * Registers a DOM event for a nested HTML element associated with the
     * component. This is only done for non-bubbling events that require
     * direct event listeners to be added.
     * @param  {String} type The DOM event type ("mouseover", "mousemove", etc.)
     * @param  {String} targetMethod The name of the method to invoke on the scoped component
     * @param  {String} elId The DOM element ID of the DOM element that the event listener needs to be added too
     */
     e: function(type, targetMethod, elId, extraArgs) {
        if (targetMethod) {
            // The event handler method is allowed to be conditional. At render time if the target
            // method is null then we do not attach any direct event listeners.
            (this.___domEvents || (this.___domEvents = [])).push([
                type,
                targetMethod,
                elId,
                extraArgs]);
        }
    },
    /**
     * Returns the next auto generated unique ID for a nested DOM element or nested DOM component
     */
    ___nextComponentId: function() {
        var id = this.id;

        return id === null ?
            this.___globalComponentsContext.___nextComponentId(this.___out) :
            id + '-c' + (this.___nextIdIndex++);
    },

    d: function(handlerMethodName, extraArgs) {
        return attachBubblingEvent(this, handlerMethodName, extraArgs);
    }
};

ComponentDef.___deserialize = function(o, types, globals, registry) {
    var id        = o[0];
    var typeName  = types[o[1]];
    var input     = o[2];
    var extra     = o[3];

    var state = extra.s;
    var componentProps = extra.w;

    var component = typeName /* legacy */ && registry.___createComponent(typeName, id);

    if (extra.b) {
        component.___bubblingDomEvents = extra.b;
    }

    // Preview newly created component from being queued for update since we area
    // just building it from the server info
    component.___updateQueued = true;

    if (state) {
        var undefinedPropNames = extra.u;
        if (undefinedPropNames) {
            undefinedPropNames.forEach(function(undefinedPropName) {
                state[undefinedPropName] = undefined;
            });
        }
        // We go through the setter here so that we convert the state object
        // to an instance of `State`
        component.state = state;
    }

    component.___input = input;

    if (componentProps) {
        extend(component, componentProps);
    }

    var scope = extra.p;
    var customEvents = extra.e;
    if (customEvents) {
        component.___setCustomEvents(customEvents, scope);
    }

    component.___global = globals;

    return {
        ___component: component,
        ___roots: extra.r,
        ___domEvents: extra.d,
        ___willRerenderInBrowser: extra._ === 1
    };
};

module.exports = ComponentDef;

});
$_mod.remap("/marko$4.4.28/src/components/registry", "/marko$4.4.28/src/components/registry-browser");
$_mod.remap("/marko$4.4.28/src/components/loadComponent", "/marko$4.4.28/src/components/loadComponent-dynamic");
$_mod.def("/marko$4.4.28/src/components/loadComponent-dynamic", function(require, exports, module, __filename, __dirname) { 'use strict';

module.exports = function load(typeName) {
    // We make the assumption that the component type name is a path to a
    // fully resolved module path and that the module exists
    // as a CommonJS module
    return require(typeName);
};
});
$_mod.def("/marko$4.4.28/src/components/State", function(require, exports, module, __filename, __dirname) { var extend = require('/raptor-util$3.2.0/extend'/*'raptor-util/extend'*/);

function ensure(state, propertyName) {
    var proto = state.constructor.prototype;
    if (!(propertyName in proto)) {
        Object.defineProperty(proto, propertyName, {
            get: function() {
                return this.___raw[propertyName];
            },
            set: function(value) {
                this.___set(propertyName, value, false /* ensure:false */);
            }
        });
    }
}

function State(component) {
    this.___component = component;
    this.___raw = {};

    this.___dirty = false;
    this.___old = null;
    this.___changes = null;
    this.___forced = null; // An object that we use to keep tracking of state properties that were forced to be dirty

    Object.seal(this);
}

State.prototype = {
    ___reset: function() {
        var self = this;

        self.___dirty = false;
        self.___old = null;
        self.___changes = null;
        self.___forced = null;
    },

    ___replace: function(newState) {
        var state = this;
        var key;

        var rawState = this.___raw;

        for (key in rawState) {
            if (!(key in newState)) {
                state.___set(key, undefined, false /* ensure:false */, false /* forceDirty:false */);
            }
        }

        for (key in newState) {
            state.___set(key, newState[key], true /* ensure:true */, false /* forceDirty:false */);
        }
    },
    ___set: function(name, value, shouldEnsure, forceDirty) {
        var rawState = this.___raw;

        if (shouldEnsure) {
            ensure(this, name);
        }

        if (forceDirty) {
            var forcedDirtyState = this.___forced || (this.___forced = {});
            forcedDirtyState[name] = true;
        } else if (rawState[name] === value) {
            return;
        }

        if (!this.___dirty) {
            // This is the first time we are modifying the component state
            // so introduce some properties to do some tracking of
            // changes to the state
            this.___dirty = true; // Mark the component state as dirty (i.e. modified)
            this.___old = rawState;
            this.___raw = rawState = extend({}, rawState);
            this.___changes = {};
            this.___component.___queueUpdate();
        }

        this.___changes[name] = value;

        if (value === undefined) {
            // Don't store state properties with an undefined or null value
            delete rawState[name];
        } else {
            // Otherwise, store the new value in the component state
            rawState[name] = value;
        }
    },
    toJSON: function() {
        return this.___raw;
    }
};

module.exports = State;

});
$_mod.remap("/marko$4.4.28/src/components/beginComponent", "/marko$4.4.28/src/components/beginComponent-browser");
$_mod.def("/marko$4.4.28/src/components/beginComponent-browser", function(require, exports, module, __filename, __dirname) { var ComponentDef = require('/marko$4.4.28/src/components/ComponentDef'/*'./ComponentDef'*/);

module.exports = function(component, isSplitComponent) {
    var componentStack = this.___componentStack;
    var origLength = componentStack.length;
    var parentComponentDef = componentStack[origLength - 1];

    var componentId = component.id;

    var componentDef = new ComponentDef(component, componentId, this.___globalContext, componentStack, origLength);
    parentComponentDef.___addChild(componentDef);
    this.___globalContext.___componentsById[componentId] = componentDef;

    componentStack.push(componentDef);

    return componentDef;
};

});
$_mod.def("/marko$4.4.28/src/components/ComponentsContext", function(require, exports, module, __filename, __dirname) { 'use strict';

var ComponentDef = require('/marko$4.4.28/src/components/ComponentDef'/*'./ComponentDef'*/);
var componentsUtil = require('/marko$4.4.28/src/components/util-browser'/*'./util'*/);

var beginComponent = require('/marko$4.4.28/src/components/beginComponent-browser'/*'./beginComponent'*/);

var EMPTY_OBJECT = {};

function GlobalComponentsContext(out) {
    this.___roots = [];
    this.___preserved = EMPTY_OBJECT;
    this.___preservedBodies = EMPTY_OBJECT;
    this.___componentsById = {};
    this.___out = out;
    this.___rerenderComponent = undefined;
    this.___nextIdLookup = null;
    this.___nextComponentId = componentsUtil.___nextComponentIdProvider(out);
}

GlobalComponentsContext.prototype = {
    ___initComponents: function(doc) {
        var topLevelComponentDefs = null;

        this.___roots.forEach(function(root) {
            var children = root.___children;
            if (children) {
                // NOTE: ComponentsContext.___initClientRendered is provided by
                //       index-browser.js to avoid a circular dependency
                ComponentsContext.___initClientRendered(children, doc);
                if (topLevelComponentDefs === null) {
                    topLevelComponentDefs = children;
                } else {
                    topLevelComponentDefs = topLevelComponentDefs.concat(children);
                }
            }
        });

        this.___roots = null;

        // Reset things stored in global since global is retained for
        // future renders
        this.___out.global.___components = undefined;

        return topLevelComponentDefs;
    },
    ___preserveDOMNode: function(elId, bodyOnly) {
        var preserved = bodyOnly === true ? this.___preservedBodies : this.___preserved;
        if (preserved === EMPTY_OBJECT) {
            if (bodyOnly === true) {
                preserved = this.___preservedBodies = {};
            } else {
                preserved = this.___preserved = {};
            }
        }
        preserved[elId] = true;
    },
    ___nextRepeatedId: function(parentId, id) {
        var nextIdLookup = this.___nextIdLookup || (this.___nextIdLookup = {});

        var indexLookupKey = parentId + '-' + id;
        var currentIndex = nextIdLookup[indexLookupKey];
        if (currentIndex == null) {
            currentIndex = nextIdLookup[indexLookupKey] = 0;
        } else {
            currentIndex = ++nextIdLookup[indexLookupKey];
        }

        return indexLookupKey.slice(0, -2) + '[' + currentIndex + ']';
    }
};

function ComponentsContext(out, parentComponentsContext, shouldAddGlobalRoot) {
    var root;

    var globalComponentsContext;

    if (parentComponentsContext === undefined) {
        globalComponentsContext = out.global.___components;
        if (globalComponentsContext === undefined) {
            out.global.___components = globalComponentsContext = new GlobalComponentsContext(out);
        }

        root = new ComponentDef(null, null, globalComponentsContext);

        if (shouldAddGlobalRoot !== false) {
            globalComponentsContext.___roots.push(root);
        }
    } else {
        globalComponentsContext = parentComponentsContext.___globalContext;
        var parentComponentStack = parentComponentsContext.___componentStack;
        root = parentComponentStack[parentComponentStack.length-1];
    }

    this.___globalContext = globalComponentsContext;
    this.___out = out;
    this.___componentStack = [root];
}

ComponentsContext.prototype = {
    ___createNestedComponentsContext: function(nestedOut) {
        return new ComponentsContext(nestedOut, this);
    },
    ___beginComponent: beginComponent,

    ___nextComponentId: function() {
        var componentStack = this.___componentStack;
        var parentComponentDef = componentStack[componentStack.length - 1];
        return parentComponentDef.___nextComponentId();
    }
};

function getComponentsContext(out) {
    return out.data.___components || (out.data.___components = new ComponentsContext(out));
}

module.exports = exports = ComponentsContext;

exports.___getComponentsContext = getComponentsContext;

});
$_mod.installed("marko$4.4.28", "listener-tracker", "2.0.0");
$_mod.main("/listener-tracker$2.0.0", "lib/listener-tracker");
$_mod.def("/listener-tracker$2.0.0/lib/listener-tracker", function(require, exports, module, __filename, __dirname) { var INDEX_EVENT = 0;
var INDEX_USER_LISTENER = 1;
var INDEX_WRAPPED_LISTENER = 2;
var DESTROY = "destroy";

function isNonEventEmitter(target) {
  return !target.once;
}

function EventEmitterWrapper(target) {
    this.$__target = target;
    this.$__listeners = [];
    this.$__subscribeTo = null;
}

EventEmitterWrapper.prototype = {
    $__remove: function(test, testWrapped) {
        var target = this.$__target;
        var listeners = this.$__listeners;

        this.$__listeners = listeners.filter(function(curListener) {
            var curEvent = curListener[INDEX_EVENT];
            var curListenerFunc = curListener[INDEX_USER_LISTENER];
            var curWrappedListenerFunc = curListener[INDEX_WRAPPED_LISTENER];

            if (testWrapped) {
                // If the user used `once` to attach an event listener then we had to
                // wrap their listener function with a new function that does some extra
                // cleanup to avoid a memory leak. If the `testWrapped` flag is set to true
                // then we are attempting to remove based on a function that we had to
                // wrap (not the user listener function)
                if (curWrappedListenerFunc && test(curEvent, curWrappedListenerFunc)) {
                    target.removeListener(curEvent, curWrappedListenerFunc);

                    return false;
                }
            } else if (test(curEvent, curListenerFunc)) {
                // If the listener function was wrapped due to it being a `once` listener
                // then we should remove from the target EventEmitter using wrapped
                // listener function. Otherwise, we remove the listener using the user-provided
                // listener function.
                target.removeListener(curEvent, curWrappedListenerFunc || curListenerFunc);

                return false;
            }

            return true;
        });

        // Fixes https://github.com/raptorjs/listener-tracker/issues/2
        // If all of the listeners stored with a wrapped EventEmitter
        // have been removed then we should unregister the wrapped
        // EventEmitter in the parent SubscriptionTracker
        var subscribeTo = this.$__subscribeTo;

        if (!this.$__listeners.length && subscribeTo) {
            var self = this;
            var subscribeToList = subscribeTo.$__subscribeToList;
            subscribeTo.$__subscribeToList = subscribeToList.filter(function(cur) {
                return cur !== self;
            });
        }
    },

    on: function(event, listener) {
        this.$__target.on(event, listener);
        this.$__listeners.push([event, listener]);
        return this;
    },

    once: function(event, listener) {
        var self = this;

        // Handling a `once` event listener is a little tricky since we need to also
        // do our own cleanup if the `once` event is emitted. Therefore, we need
        // to wrap the user's listener function with our own listener function.
        var wrappedListener = function() {
            self.$__remove(function(event, listenerFunc) {
                return wrappedListener === listenerFunc;
            }, true /* We are removing the wrapped listener */);

            listener.apply(this, arguments);
        };

        this.$__target.once(event, wrappedListener);
        this.$__listeners.push([event, listener, wrappedListener]);
        return this;
    },

    removeListener: function(event, listener) {
        if (typeof event === 'function') {
            listener = event;
            event = null;
        }

        if (listener && event) {
            this.$__remove(function(curEvent, curListener) {
                return event === curEvent && listener === curListener;
            });
        } else if (listener) {
            this.$__remove(function(curEvent, curListener) {
                return listener === curListener;
            });
        } else if (event) {
            this.removeAllListeners(event);
        }

        return this;
    },

    removeAllListeners: function(event) {

        var listeners = this.$__listeners;
        var target = this.$__target;

        if (event) {
            this.$__remove(function(curEvent, curListener) {
                return event === curEvent;
            });
        } else {
            for (var i = listeners.length - 1; i >= 0; i--) {
                var cur = listeners[i];
                target.removeListener(cur[INDEX_EVENT], cur[INDEX_USER_LISTENER]);
            }
            this.$__listeners.length = 0;
        }

        return this;
    }
};

function EventEmitterAdapter(target) {
    this.$__target = target;
}

EventEmitterAdapter.prototype = {
    on: function(event, listener) {
        this.$__target.addEventListener(event, listener);
        return this;
    },

    once: function(event, listener) {
        var self = this;

        // need to save this so we can remove it below
        var onceListener = function() {
          self.$__target.removeEventListener(event, onceListener);
          listener();
        };
        this.$__target.addEventListener(event, onceListener);
        return this;
    },

    removeListener: function(event, listener) {
        this.$__target.removeEventListener(event, listener);
        return this;
    }
};

function SubscriptionTracker() {
    this.$__subscribeToList = [];
}

SubscriptionTracker.prototype = {

    subscribeTo: function(target, options) {
        var addDestroyListener = !options || options.addDestroyListener !== false;
        var wrapper;
        var nonEE;
        var subscribeToList = this.$__subscribeToList;

        for (var i=0, len=subscribeToList.length; i<len; i++) {
            var cur = subscribeToList[i];
            if (cur.$__target === target) {
                wrapper = cur;
                break;
            }
        }

        if (!wrapper) {
            if (isNonEventEmitter(target)) {
              nonEE = new EventEmitterAdapter(target);
            }

            wrapper = new EventEmitterWrapper(nonEE || target);
            if (addDestroyListener && !nonEE) {
                wrapper.once(DESTROY, function() {
                    wrapper.removeAllListeners();

                    for (var i = subscribeToList.length - 1; i >= 0; i--) {
                        if (subscribeToList[i].$__target === target) {
                            subscribeToList.splice(i, 1);
                            break;
                        }
                    }
                });
            }

            // Store a reference to the parent SubscriptionTracker so that we can do cleanup
            // if the EventEmitterWrapper instance becomes empty (i.e., no active listeners)
            wrapper.$__subscribeTo = this;
            subscribeToList.push(wrapper);
        }

        return wrapper;
    },

    removeAllListeners: function(target, event) {
        var subscribeToList = this.$__subscribeToList;
        var i;

        if (target) {
            for (i = subscribeToList.length - 1; i >= 0; i--) {
                var cur = subscribeToList[i];
                if (cur.$__target === target) {
                    cur.removeAllListeners(event);

                    if (!cur.$__listeners.length) {
                        // Do some cleanup if we removed all
                        // listeners for the target event emitter
                        subscribeToList.splice(i, 1);
                    }

                    break;
                }
            }
        } else {
            for (i = subscribeToList.length - 1; i >= 0; i--) {
                subscribeToList[i].removeAllListeners();
            }
            subscribeToList.length = 0;
        }
    }
};

exports = module.exports = SubscriptionTracker;

exports.wrap = function(targetEventEmitter) {
    var nonEE;
    var wrapper;

    if (isNonEventEmitter(targetEventEmitter)) {
      nonEE = new EventEmitterAdapter(targetEventEmitter);
    }

    wrapper = new EventEmitterWrapper(nonEE || targetEventEmitter);
    if (!nonEE) {
      // we don't set this for non EE types
      targetEventEmitter.once(DESTROY, function() {
          wrapper.$__listeners.length = 0;
      });
    }

    return wrapper;
};

exports.createTracker = function() {
    return new SubscriptionTracker();
};

});
$_mod.remap("/marko$4.4.28/src/runtime/nextTick", "/marko$4.4.28/src/runtime/nextTick-browser");
$_mod.def("/marko$4.4.28/src/runtime/nextTick-browser", function(require, exports, module, __filename, __dirname) { /* globals window */

var win = window;
var setImmediate = win.setImmediate;

if (!setImmediate) {
    if (win.postMessage) {
        var queue = [];
        var messageName = 'si';
        win.addEventListener('message', function (event) {
            var source = event.source;
            if (source == win || !source && event.data === messageName) {
                event.stopPropagation();
                if (queue.length > 0) {
                    var fn = queue.shift();
                    fn();
                }
            }
        }, true);

        setImmediate = function(fn) {
            queue.push(fn);
            win.postMessage(messageName, '*');
        };
    } else {
        setImmediate = setTimeout;
    }
}

module.exports = setImmediate;

});
$_mod.def("/marko$4.4.28/src/components/update-manager", function(require, exports, module, __filename, __dirname) { 'use strict';

var updatesScheduled = false;
var batchStack = []; // A stack of batched updates
var unbatchedQueue = []; // Used for scheduled batched updates

var nextTick = require('/marko$4.4.28/src/runtime/nextTick-browser'/*'../runtime/nextTick'*/);

/**
 * This function is called when we schedule the update of "unbatched"
 * updates to components.
 */
function updateUnbatchedComponents() {
    if (unbatchedQueue.length) {
        try {
            updateComponents(unbatchedQueue);
        } finally {
            // Reset the flag now that this scheduled batch update
            // is complete so that we can later schedule another
            // batched update if needed
            updatesScheduled = false;
        }
    }
}

function scheduleUpdates() {
    if (updatesScheduled) {
        // We have already scheduled a batched update for the
        // process.nextTick so nothing to do
        return;
    }

    updatesScheduled = true;

    nextTick(updateUnbatchedComponents);
}

function updateComponents(queue) {
    // Loop over the components in the queue and update them.
    // NOTE: It is okay if the queue grows during the iteration
    //       since we will still get to them at the end
    for (var i=0; i<queue.length; i++) {
        var component = queue[i];
        component.___update(); // Do the actual component update
    }

    // Clear out the queue by setting the length to zero
    queue.length = 0;
}

function batchUpdate(func) {
    // If the batched update stack is empty then this
    // is the outer batched update. After the outer
    // batched update completes we invoke the "afterUpdate"
    // event listeners.
    var batch = {
        ___queue: null
    };

    batchStack.push(batch);

    try {
        func();
    } finally {
        try {
            // Update all of the components that where queued up
            // in this batch (if any)
            if (batch.___queue) {
                updateComponents(batch.___queue);
            }
        } finally {
            // Now that we have completed the update of all the components
            // in this batch we need to remove it off the top of the stack
            batchStack.length--;
        }
    }
}

function queueComponentUpdate(component) {
    var batchStackLen = batchStack.length;

    if (batchStackLen) {
        // When a batch update is started we push a new batch on to a stack.
        // If the stack has a non-zero length then we know that a batch has
        // been started so we can just queue the component on the top batch. When
        // the batch is ended this component will be updated.
        var batch = batchStack[batchStackLen-1];

        // We default the batch queue to null to avoid creating an Array instance
        // unnecessarily. If it is null then we create a new Array, otherwise
        // we push it onto the existing Array queue
        if (batch.___queue) {
            batch.___queue.push(component);
        } else {
            batch.___queue = [component];
        }
    } else {
        // We are not within a batched update. We need to schedule a batch update
        // for the process.nextTick (if that hasn't been done already) and we will
        // add the component to the unbatched queued
        scheduleUpdates();
        unbatchedQueue.push(component);
    }
}

exports.___queueComponentUpdate = queueComponentUpdate;
exports.___batchUpdate = batchUpdate;

});
$_mod.main("/marko$4.4.28/src/morphdom", "");
$_mod.def("/marko$4.4.28/src/morphdom/index", function(require, exports, module, __filename, __dirname) { 'use strict';
var defaultDoc = typeof document == 'undefined' ? undefined : document;
var specialElHandlers = require('/marko$4.4.28/src/morphdom/specialElHandlers'/*'./specialElHandlers'*/);

var morphAttrs = require('/marko$4.4.28/src/runtime/vdom/VElement'/*'../runtime/vdom/VElement'*/).___morphAttrs;

var ELEMENT_NODE = 1;
var TEXT_NODE = 3;
var COMMENT_NODE = 8;

function compareNodeNames(fromEl, toEl) {
    return fromEl.nodeName === toEl.___nodeName;
}


function getElementById(doc, id) {
    return doc.getElementById(id);
}

function morphdom(
        fromNode,
        toNode,
        context,
        onNodeAdded,
        onBeforeElUpdated,
        onBeforeNodeDiscarded,
        onNodeDiscarded,
        onBeforeElChildrenUpdated
    ) {

    var doc = fromNode.ownerDocument || defaultDoc;

    // This object is used as a lookup to quickly find all keyed elements in the original DOM tree.
    var removalList = [];
    var foundKeys = {};

    function walkDiscardedChildNodes(node) {
        onNodeDiscarded(node);
        var curChild = node.firstChild;

        while (curChild) {
            walkDiscardedChildNodes(curChild);
            curChild = curChild.nextSibling;
        }
    }


    function addVirtualNode(vEl, parentEl) {
        var realEl = vEl.___actualize(doc);

        if (parentEl) {
            parentEl.appendChild(realEl);
        }

        onNodeAdded(realEl, context);

        var vCurChild = vEl.___firstChild;
        while (vCurChild) {
            var realCurChild = null;

            var key = vCurChild.id;
            if (key) {
                var unmatchedFromEl = getElementById(doc, key);
                if (unmatchedFromEl && compareNodeNames(vCurChild, unmatchedFromEl)) {
                    morphEl(unmatchedFromEl, vCurChild, false);
                    realEl.appendChild(realCurChild = unmatchedFromEl);
                }
            }

            if (!realCurChild) {
                addVirtualNode(vCurChild, realEl);
            }

            vCurChild = vCurChild.___nextSibling;
        }

        if (vEl.___nodeType === 1) {
            var elHandler = specialElHandlers[vEl.nodeName];
            if (elHandler !== undefined) {
                elHandler(realEl, vEl);
            }
        }

        return realEl;
    }

    function morphEl(fromEl, toEl, childrenOnly) {
        var toElKey = toEl.id;
        var nodeName = toEl.___nodeName;

        if (childrenOnly === false) {
            if (toElKey) {
                // If an element with an ID is being morphed then it is will be in the final
                // DOM so clear it out of the saved elements collection
                foundKeys[toElKey] = true;
            }

            var constId = toEl.___constId;
            if (constId !== undefined) {
                var otherProps = fromEl._vprops;
                if (otherProps !== undefined && constId === otherProps.c) {
                    return;
                }
            }

            if (onBeforeElUpdated(fromEl, toElKey, context) === true) {
                return;
            }

            morphAttrs(fromEl, toEl);
        }


        if (onBeforeElChildrenUpdated(fromEl, toElKey, context) === true) {
            return;
        }

        if (nodeName !== 'TEXTAREA') {
            var curToNodeChild = toEl.___firstChild;
            var curFromNodeChild = fromEl.firstChild;
            var curToNodeKey;
            var curFromNodeKey;

            var fromNextSibling;
            var toNextSibling;
            var matchingFromEl;

            outer: while (curToNodeChild) {
                toNextSibling = curToNodeChild.___nextSibling;
                curToNodeKey = curToNodeChild.id;

                while (curFromNodeChild) {
                    fromNextSibling = curFromNodeChild.nextSibling;

                    curFromNodeKey = curFromNodeChild.id;

                    var curFromNodeType = curFromNodeChild.nodeType;

                    var isCompatible = undefined;

                    if (curFromNodeType === curToNodeChild.___nodeType) {
                        if (curFromNodeType === ELEMENT_NODE) {
                            // Both nodes being compared are Element nodes

                            if (curToNodeKey) {
                                // The target node has a key so we want to match it up with the correct element
                                // in the original DOM tree
                                if (curToNodeKey !== curFromNodeKey) {
                                    // The current element in the original DOM tree does not have a matching key so
                                    // let's check our lookup to see if there is a matching element in the original
                                    // DOM tree
                                    if ((matchingFromEl = getElementById(doc, curToNodeKey))) {
                                        if (curFromNodeChild.nextSibling === matchingFromEl) {
                                            // Special case for single element removals. To avoid removing the original
                                            // DOM node out of the tree (since that can break CSS transitions, etc.),
                                            // we will instead discard the current node and wait until the next
                                            // iteration to properly match up the keyed target element with its matching
                                            // element in the original tree
                                            isCompatible = false;
                                        } else {
                                            // We found a matching keyed element somewhere in the original DOM tree.
                                            // Let's moving the original DOM node into the current position and morph
                                            // it.

                                            // NOTE: We use insertBefore instead of replaceChild because we want to go through
                                            // the `removeNode()` function for the node that is being discarded so that
                                            // all lifecycle hooks are correctly invoked


                                            fromEl.insertBefore(matchingFromEl, curFromNodeChild);

                                            fromNextSibling = curFromNodeChild.nextSibling;
                                            removalList.push(curFromNodeChild);

                                            curFromNodeChild = matchingFromEl;
                                        }
                                    } else {
                                        // The nodes are not compatible since the "to" node has a key and there
                                        // is no matching keyed node in the source tree
                                        isCompatible = false;
                                    }
                                }
                            } else if (curFromNodeKey) {
                                // The original has a key
                                isCompatible = false;
                            }

                            isCompatible = isCompatible !== false && compareNodeNames(curFromNodeChild, curToNodeChild) === true;

                            if (isCompatible === true) {
                                // We found compatible DOM elements so transform
                                // the current "from" node to match the current
                                // target DOM node.
                                morphEl(curFromNodeChild, curToNodeChild, false);
                            }

                        } else if (curFromNodeType === TEXT_NODE || curFromNodeType === COMMENT_NODE) {
                            // Both nodes being compared are Text or Comment nodes
                            isCompatible = true;
                            // Simply update nodeValue on the original node to
                            // change the text value
                            curFromNodeChild.nodeValue = curToNodeChild.___nodeValue;
                        }
                    }

                    if (isCompatible === true) {
                        // Advance both the "to" child and the "from" child since we found a match
                        curToNodeChild = toNextSibling;
                        curFromNodeChild = fromNextSibling;
                        continue outer;
                    }

                    // No compatible match so remove the old node from the DOM and continue trying to find a
                    // match in the original DOM. However, we only do this if the from node is not keyed
                    // since it is possible that a keyed node might match up with a node somewhere else in the
                    // target tree and we don't want to discard it just yet since it still might find a
                    // home in the final DOM tree. After everything is done we will remove any keyed nodes
                    // that didn't find a home
                    removalList.push(curFromNodeChild);

                    curFromNodeChild = fromNextSibling;
                }

                // If we got this far then we did not find a candidate match for
                // our "to node" and we exhausted all of the children "from"
                // nodes. Therefore, we will just append the current "to" node
                // to the end
                if (curToNodeKey && (matchingFromEl = getElementById(doc, curToNodeKey)) && compareNodeNames(matchingFromEl, curToNodeChild)) {
                    fromEl.appendChild(matchingFromEl);
                    morphEl(matchingFromEl, curToNodeChild, false);
                } else {
                    addVirtualNode(curToNodeChild, fromEl);
                }

                curToNodeChild = toNextSibling;
                curFromNodeChild = fromNextSibling;
            }

            // We have processed all of the "to nodes". If curFromNodeChild is
            // non-null then we still have some from nodes left over that need
            // to be removed
            while (curFromNodeChild) {
                removalList.push(curFromNodeChild);
                curFromNodeChild = curFromNodeChild.nextSibling;
            }
        }

        var specialElHandler = specialElHandlers[nodeName];
        if (specialElHandler) {
            specialElHandler(fromEl, toEl);
        }
    } // END: morphEl(...)

    var morphedNode = fromNode;
    var fromNodeType = morphedNode.nodeType;
    var toNodeType = toNode.___nodeType;
    var morphChildrenOnly = false;
    var shouldMorphEl = true;
    var newNode;

    // Handle the case where we are given two DOM nodes that are not
    // compatible (e.g. <div> --> <span> or <div> --> TEXT)
    if (fromNodeType == ELEMENT_NODE) {
        if (toNodeType == ELEMENT_NODE) {
            if (!compareNodeNames(fromNode, toNode)) {
                newNode = toNode.___actualize(doc);
                morphChildrenOnly = true;
                removalList.push(fromNode);
            }
        } else {
            // Going from an element node to a text or comment node
            removalList.push(fromNode);
            newNode = toNode.___actualize(doc);
            shouldMorphEl = false;
        }
    } else if (fromNodeType == TEXT_NODE || fromNodeType == COMMENT_NODE) { // Text or comment node
        if (toNodeType == fromNodeType) {
            morphedNode.nodeValue = toNode.___nodeValue;
            return morphedNode;
        } else {
            // Text node to something else
            removalList.push(fromNode);
            newNode = addVirtualNode(toNode);
            shouldMorphEl = false;
        }
    }

    if (shouldMorphEl === true) {
        morphEl(newNode || morphedNode, toNode, morphChildrenOnly);
    }

    if (newNode) {
        if (fromNode.parentNode) {
            fromNode.parentNode.replaceChild(newNode, fromNode);
        }
    }

    // We now need to loop over any keyed nodes that might need to be
    // removed. We only do the removal if we know that the keyed node
    // never found a match. When a keyed node is matched up we remove
    // it out of fromNodesLookup and we use fromNodesLookup to determine
    // if a keyed node has been matched up or not
    for (var i=0, len=removalList.length; i<len; i++) {
        var node = removalList[i];
        var key = node.id;
        if (!key || foundKeys[key] === undefined) {
            var parentNode = node.parentNode;
            if (parentNode !== null || node === fromNode) {
                if (onBeforeNodeDiscarded(node) == false) {
                    continue;
                }

                if (parentNode !== null) {
                    parentNode.removeChild(node);
                }

                walkDiscardedChildNodes(node);
            }
        }
    }

    return newNode || morphedNode;
}

module.exports = morphdom;

});
$_mod.def("/marko$4.4.28/src/components/Component", function(require, exports, module, __filename, __dirname) { 'use strict';
/* jshint newcap:false */

var domInsert = require('/marko$4.4.28/src/runtime/dom-insert'/*'../runtime/dom-insert'*/);
var defaultCreateOut = require('/marko$4.4.28/src/runtime/createOut'/*'../runtime/createOut'*/);
var getComponentsContext = require('/marko$4.4.28/src/components/ComponentsContext'/*'./ComponentsContext'*/).___getComponentsContext;
var componentsUtil = require('/marko$4.4.28/src/components/util-browser'/*'./util'*/);
var componentLookup = componentsUtil.___componentLookup;
var emitLifecycleEvent = componentsUtil.___emitLifecycleEvent;
var destroyComponentForEl = componentsUtil.___destroyComponentForEl;
var destroyElRecursive = componentsUtil.___destroyElRecursive;
var getElementById = componentsUtil.___getElementById;
var EventEmitter = require('/events-light$1.0.5/src/index'/*'events-light'*/);
var RenderResult = require('/marko$4.4.28/src/runtime/RenderResult'/*'../runtime/RenderResult'*/);
var SubscriptionTracker = require('/listener-tracker$2.0.0/lib/listener-tracker'/*'listener-tracker'*/);
var inherit = require('/raptor-util$3.2.0/inherit'/*'raptor-util/inherit'*/);
var updateManager = require('/marko$4.4.28/src/components/update-manager'/*'./update-manager'*/);
var morphdom = require('/marko$4.4.28/src/morphdom/index'/*'../morphdom'*/);
var eventDelegation = require('/marko$4.4.28/src/components/event-delegation'/*'./event-delegation'*/);

var slice = Array.prototype.slice;

var MORPHDOM_SKIP = true;

var COMPONENT_SUBSCRIBE_TO_OPTIONS;
var NON_COMPONENT_SUBSCRIBE_TO_OPTIONS = {
    addDestroyListener: false
};

function outNoop() { /* jshint -W040 */ return this; }

var emit = EventEmitter.prototype.emit;

function removeListener(removeEventListenerHandle) {
    removeEventListenerHandle();
}

function checkCompatibleComponent(globalComponentsContext, el) {
    var component = el._w;
    while(component) {
        var id = component.id;
        var newComponentDef = globalComponentsContext.___componentsById[id];
        if (newComponentDef && component.___type == newComponentDef.___component.___type) {
            break;
        }

        var rootFor = component.___rootFor;
        if (rootFor)  {
            component = rootFor;
        } else {
            component.___destroyShallow();
            break;
        }
    }
}

function handleCustomEventWithMethodListener(component, targetMethodName, args, extraArgs) {
    // Remove the "eventType" argument
    args.push(component);

    if (extraArgs) {
        args = extraArgs.concat(args);
    }


    var targetComponent = componentLookup[component.___scope];
    var targetMethod = targetComponent[targetMethodName];
    if (!targetMethod) {
        throw Error('Method not found: ' + targetMethodName);
    }

    targetMethod.apply(targetComponent, args);
}

function getElIdHelper(component, componentElId, index) {
    var id = component.id;

    var elId = componentElId != null ? id + '-' + componentElId : id;

    if (index != null) {
        elId += '[' + index + ']';
    }

    return elId;
}

/**
 * This method is used to process "update_<stateName>" handler functions.
 * If all of the modified state properties have a user provided update handler
 * then a rerender will be bypassed and, instead, the DOM will be updated
 * looping over and invoking the custom update handlers.
 * @return {boolean} Returns true if if the DOM was updated. False, otherwise.
 */
function processUpdateHandlers(component, stateChanges, oldState) {
    var handlerMethod;
    var handlers;

    for (var propName in stateChanges) {
        if (stateChanges.hasOwnProperty(propName)) {
            var handlerMethodName = 'update_' + propName;

            handlerMethod = component[handlerMethodName];
            if (handlerMethod) {
                (handlers || (handlers=[])).push([propName, handlerMethod]);
            } else {
                // This state change does not have a state handler so return false
                // to force a rerender
                return;
            }
        }
    }

    // If we got here then all of the changed state properties have
    // an update handler or there are no state properties that actually
    // changed.
    if (handlers) {
        // Otherwise, there are handlers for all of the changed properties
        // so apply the updates using those handlers

        handlers.forEach(function(handler, i) {
            var propertyName = handler[0];
            handlerMethod = handler[1];

            var newValue = stateChanges[propertyName];
            var oldValue = oldState[propertyName];
            handlerMethod.call(component, newValue, oldValue);
        });

        emitLifecycleEvent(component, 'update');

        component.___reset();
    }

    return true;
}

function checkInputChanged(existingComponent, oldInput, newInput) {
    if (oldInput != newInput) {
        if (oldInput == null || newInput == null) {
            return true;
        }

        var oldKeys = Object.keys(oldInput);
        var newKeys = Object.keys(newInput);
        var len = oldKeys.length;
        if (len !== newKeys.length) {
            return true;
        }

        for (var i=0; i<len; i++) {
            var key = oldKeys[i];
            if (oldInput[key] !== newInput[key]) {
                return true;
            }
        }
    }

    return false;
}

function onNodeDiscarded(node) {
    if (node.nodeType === 1) {
        destroyComponentForEl(node);
    }
}

function onBeforeNodeDiscarded(node) {
    return eventDelegation.___handleNodeDetach(node);
}

function onBeforeElUpdated(fromEl, key, globalComponentsContext) {
    if (key) {
        var preserved = globalComponentsContext.___preserved[key];

        if (preserved === true) {
            // Don't morph elements that are associated with components that are being
            // reused or elements that are being preserved. For components being reused,
            // the morphing will take place when the reused component updates.
            return MORPHDOM_SKIP;
        } else {
            // We may need to destroy a Component associated with the current element
            // if a new UI component was rendered to the same element and the types
            // do not match
            checkCompatibleComponent(globalComponentsContext, fromEl);
        }
    }
}

function onBeforeElChildrenUpdated(el, key, globalComponentsContext) {
    if (key) {
        var preserved = globalComponentsContext.___preservedBodies[key];
        if (preserved === true) {
            // Don't morph the children since they are preserved
            return MORPHDOM_SKIP;
        }
    }
}

function onNodeAdded(node, globalComponentsContext) {
    eventDelegation.___handleNodeAttach(node, globalComponentsContext.___out);
}

var componentProto;

/**
 * Base component type.
 *
 * NOTE: Any methods that are prefixed with an underscore should be considered private!
 */
function Component(id) {
    EventEmitter.call(this);
    this.id = id;
    this.el = null;
    this.___state = null;
    this.___roots = null;
    this.___subscriptions = null;
    this.___domEventListenerHandles = null;
    this.___bubblingDomEvents = null; // Used to keep track of bubbling DOM events for components rendered on the server
    this.___customEvents = null;
    this.___scope = null;
    this.___renderInput = null;
    this.___input = undefined;
    this.___mounted = false;
    this.___global = undefined;

    this.___destroyed = false;
    this.___updateQueued = false;
    this.___dirty = false;
    this.___settingInput = false;

    this.___document = undefined;
}

Component.prototype = componentProto = {
    ___isComponent: true,

    subscribeTo: function(target) {
        if (!target) {
            throw TypeError();
        }

        var subscriptions = this.___subscriptions || (this.___subscriptions = new SubscriptionTracker());

        var subscribeToOptions = target.___isComponent ?
            COMPONENT_SUBSCRIBE_TO_OPTIONS :
            NON_COMPONENT_SUBSCRIBE_TO_OPTIONS;

        return subscriptions.subscribeTo(target, subscribeToOptions);
    },

    emit: function(eventType) {
        var customEvents = this.___customEvents;
        var target;

        if (customEvents && (target = customEvents[eventType])) {
            var targetMethodName = target[0];
            var extraArgs = target[1];
            var args = slice.call(arguments, 1);

            handleCustomEventWithMethodListener(this, targetMethodName, args, extraArgs);
        }

        if (this.listenerCount(eventType)) {
            return emit.apply(this, arguments);
        }
    },
    getElId: function (componentElId, index) {
        return getElIdHelper(this, componentElId, index);
    },
    getEl: function (componentElId, index) {
        var doc = this.___document;

        if (componentElId != null) {
            return getElementById(doc, getElIdHelper(this, componentElId, index));
        } else {
            return this.el || getElementById(doc, getElIdHelper(this));
        }
    },
    getEls: function(id) {
        var els = [];
        var i = 0;
        var el;
        while((el = this.getEl(id, i))) {
            els.push(el);
            i++;
        }
        return els;
    },
    getComponent: function(id, index) {
        return componentLookup[getElIdHelper(this, id, index)];
    },
    getComponents: function(id) {
        var components = [];
        var i = 0;
        var component;
        while((component = componentLookup[getElIdHelper(this, id, i)])) {
            components.push(component);
            i++;
        }
        return components;
    },
    destroy: function() {
        if (this.___destroyed) {
            return;
        }

        var els = this.els;

        this.___destroyShallow();

        var rootComponents = this.___rootComponents;
        if (rootComponents) {
            rootComponents.forEach(function(rootComponent) {
                rootComponent.___destroy();
            });
        }

        els.forEach(function(el) {
            destroyElRecursive(el);

            var parentNode = el.parentNode;
            if (parentNode) {
                parentNode.removeChild(el);
            }
        });
    },

    ___destroyShallow: function() {
        if (this.___destroyed) {
            return;
        }

        emitLifecycleEvent(this, 'destroy');
        this.___destroyed = true;

        this.el = null;

        // Unsubscribe from all DOM events
        this.___removeDOMEventListeners();

        var subscriptions = this.___subscriptions;
        if (subscriptions) {
            subscriptions.removeAllListeners();
            this.___subscriptions = null;
        }

        delete componentLookup[this.id];
    },

    isDestroyed: function() {
        return this.___destroyed;
    },
    get state() {
        return this.___state;
    },
    set state(newState) {
        var state = this.___state;
        if (!state && !newState) {
            return;
        }

        if (!state) {
            state = this.___state = new this.___State(this);
        }

        state.___replace(newState || {});

        if (state.___dirty) {
            this.___queueUpdate();
        }

        if (!newState) {
            this.___state = null;
        }
    },
    setState: function(name, value) {
        var state = this.___state;

        if (typeof name == 'object') {
            // Merge in the new state with the old state
            var newState = name;
            for (var k in newState) {
                if (newState.hasOwnProperty(k)) {
                    state.___set(k, newState[k], true /* ensure:true */);
                }
            }
        } else {
            state.___set(name, value, true /* ensure:true */);
        }
    },

    setStateDirty: function(name, value) {
        var state = this.___state;

        if (arguments.length == 1) {
            value = state[name];
        }

        state.___set(name, value, true /* ensure:true */, true /* forceDirty:true */);
    },

    replaceState: function(newState) {
        this.___state.___replace(newState);
    },

    get input() {
        return this.___input;
    },
    set input(newInput) {
        if (this.___settingInput) {
            this.___input = newInput;
        } else {
            this.___setInput(newInput);
        }
    },

    ___setInput: function(newInput, onInput, out) {
        onInput = onInput || this.onInput;
        var updatedInput;

        var oldInput = this.___input;
        this.___input = undefined;

        if (onInput) {
            // We need to set a flag to preview `this.input = foo` inside
            // onInput causing infinite recursion
            this.___settingInput = true;
            updatedInput = onInput.call(this, newInput || {}, out);
            this.___settingInput = false;
        }

        newInput = this.___renderInput = updatedInput || newInput;

        if ((this.___dirty = checkInputChanged(this, oldInput, newInput))) {
            this.___queueUpdate();
        }

        if (this.___input === undefined) {
            this.___input = newInput;
            if (newInput && newInput.$global) {
                this.___global = newInput.$global;
            }
        }

        return newInput;
    },

    forceUpdate: function() {
        this.___dirty = true;
        this.___queueUpdate();
    },

    ___queueUpdate: function() {
        if (!this.___updateQueued) {
            updateManager.___queueComponentUpdate(this);
        }
    },

    update: function() {
        if (this.___destroyed === true || this.___isDirty === false) {
            return;
        }

        var input = this.___input;
        var state = this.___state;

        if (this.___dirty === false && state !== null && state.___dirty === true) {
            if (processUpdateHandlers(this, state.___changes, state.___old, state)) {
                state.___dirty = false;
            }
        }

        if (this.___isDirty === true) {
            // The UI component is still dirty after process state handlers
            // then we should rerender

            if (this.shouldUpdate(input, state) !== false) {
                this.___rerender(false);
            }
        }

        this.___reset();
    },


    get ___isDirty() {
        return this.___dirty === true || (this.___state !== null && this.___state.___dirty === true);
    },

    ___reset: function() {
        this.___dirty = false;
        this.___updateQueued = false;
        this.___renderInput = null;
        var state = this.___state;
        if (state) {
            state.___reset();
        }
    },

    shouldUpdate: function(newState, newProps) {
        return true;
    },

    ___emitLifecycleEvent: function(eventType, eventArg1, eventArg2) {
        emitLifecycleEvent(this, eventType, eventArg1, eventArg2);
    },

    ___rerender: function(isRerenderInBrowser) {
        var self = this;
        var renderer = self.___renderer;

        if (!renderer) {
            throw TypeError();
        }
        var fromEls = self.___getRootEls({});
        var doc = self.___document;
        var input = this.___renderInput || this.___input;
        var globalData = this.___global;

        updateManager.___batchUpdate(function() {
            var createOut = renderer.createOut || defaultCreateOut;
            var out = createOut(globalData);
            out.sync();
            out.___document = self.___document;

            if (isRerenderInBrowser === true) {
                out.e =
                    out.be =
                    out.ee =
                    out.t =
                    out.h =
                    out.w =
                    out.write =
                    out.html =
                    outNoop;
            }

            var componentsContext = getComponentsContext(out);
            var globalComponentsContext = componentsContext.___globalContext;
            globalComponentsContext.___rerenderComponent = self;
            globalComponentsContext.___isRerenderInBrowser = isRerenderInBrowser;

            renderer(input, out);

            var result = new RenderResult(out);

            if (isRerenderInBrowser !== true) {
                var targetNode = out.___getOutput();

                var fromEl;

                var targetEl = targetNode.___firstChild;
                while (targetEl) {
                    var nodeName = targetEl.___nodeName;

                    if (nodeName === 'HTML') {
                        fromEl = document.documentElement;
                    } else if (nodeName === 'BODY') {
                        fromEl = document.body;
                    } else if (nodeName === 'HEAD') {
                        fromEl = document.head;
                    } else {
                        fromEl = fromEls[targetEl.id];
                    }

                    if (fromEl) {
                        morphdom(
                            fromEl,
                            targetEl,
                            globalComponentsContext,
                            onNodeAdded,
                            onBeforeElUpdated,
                            onBeforeNodeDiscarded,
                            onNodeDiscarded,
                            onBeforeElChildrenUpdated);
                    }

                    targetEl = targetEl.___nextSibling;
                }
            }

            result.afterInsert(doc);

            out.emit('___componentsInitialized');
        });

        this.___reset();
    },

    ___getRootEls: function(rootEls) {
        var i, len;

        var componentEls = this.els;

        for (i=0, len=componentEls.length; i<len; i++) {
            var componentEl = componentEls[i];
            rootEls[componentEl.id] = componentEl;
        }

        var rootComponents = this.___rootComponents;
        if (rootComponents) {
            for (i=0, len=rootComponents.length; i<len; i++) {
                var rootComponent = rootComponents[i];
                rootComponent.___getRootEls(rootEls);
            }
        }

        return rootEls;
    },

    ___removeDOMEventListeners: function() {
        var eventListenerHandles = this.___domEventListenerHandles;
        if (eventListenerHandles) {
            eventListenerHandles.forEach(removeListener);
            this.___domEventListenerHandles = null;
        }
    },

    get ___rawState() {
        var state = this.___state;
        return state && state.___raw;
    },

    ___setCustomEvents: function(customEvents, scope) {
        var finalCustomEvents = this.___customEvents = {};
        this.___scope = scope;

        customEvents.forEach(function(customEvent) {
            var eventType = customEvent[0];
            var targetMethodName = customEvent[1];
            var extraArgs = customEvent[2];

            finalCustomEvents[eventType] = [targetMethodName, extraArgs];
        });
    }
};

componentProto.elId = componentProto.getElId;
componentProto.___update = componentProto.update;
componentProto.___destroy = componentProto.destroy;

// Add all of the following DOM methods to Component.prototype:
// - appendTo(referenceEl)
// - replace(referenceEl)
// - replaceChildrenOf(referenceEl)
// - insertBefore(referenceEl)
// - insertAfter(referenceEl)
// - prependTo(referenceEl)
domInsert(
    componentProto,
    function getEl(component) {
        var els = this.els;
        var elCount = els.length;
        if (elCount > 1) {
            var fragment = component.___document.createDocumentFragment();
            els.forEach(function(el) {
                fragment.appendChild(el);
            });
            return fragment;
        } else {
            return els[0];
        }
    },
    function afterInsert(component) {
        return component;
    });

inherit(Component, EventEmitter);

module.exports = Component;

});
$_mod.def("/marko$4.4.28/src/components/defineComponent", function(require, exports, module, __filename, __dirname) { 'use strict';
/* jshint newcap:false */

var BaseState = require('/marko$4.4.28/src/components/State'/*'./State'*/);
var BaseComponent = require('/marko$4.4.28/src/components/Component'/*'./Component'*/);
var inherit = require('/raptor-util$3.2.0/inherit'/*'raptor-util/inherit'*/);

module.exports = function defineComponent(def, renderer) {
    if (def.___isComponent) {
        return def;
    }

    var ComponentClass = function() {};
    var proto;

    var type = typeof def;

    if (type == 'function') {
        proto = def.prototype;
    } else if (type == 'object') {
        proto = def;
    } else {
        throw TypeError();
    }

    ComponentClass.prototype = proto;

    // We don't use the constructor provided by the user
    // since we don't invoke their constructor until
    // we have had a chance to do our own initialization.
    // Instead, we store their constructor in the "initComponent"
    // property and that method gets called later inside
    // init-components-browser.js
    function Component(id) {
        BaseComponent.call(this, id);
    }

    if (!proto.___isComponent) {
        // Inherit from Component if they didn't already
        inherit(ComponentClass, BaseComponent);
    }

    // The same prototype will be used by our constructor after
    // we he have set up the prototype chain using the inherit function
    proto = Component.prototype = ComponentClass.prototype;

    // proto.constructor = def.constructor = Component;

    // Set a flag on the constructor function to make it clear this is
    // a component so that we can short-circuit this work later
    Component.___isComponent = true;

    function State(component) { BaseState.call(this, component); }
    inherit(State, BaseState);
    proto.___State = State;
    proto.___renderer = renderer;

    return Component;
};

});
$_mod.def("/marko$4.4.28/src/components/registry-browser", function(require, exports, module, __filename, __dirname) { var loadComponent = require('/marko$4.4.28/src/components/loadComponent-dynamic'/*'./loadComponent'*/);
var defineComponent = require('/marko$4.4.28/src/components/defineComponent'/*'./defineComponent'*/);

var registered = {};
var loaded = {};
var componentTypes = {};

function register(typeName, def) {
    // We do this to kick off registering of nested components
    // but we don't use the return value just yet since there
    // is a good chance that it resulted in a circular dependency
    def();

    registered[typeName] = def;
    delete loaded[typeName];
    delete componentTypes[typeName];
    return typeName;
}

function load(typeName) {
    var target = loaded[typeName];
    if (!target) {
        target = registered[typeName];

        if (target) {
            target = target();
        } else {
            target = loadComponent(typeName); // Assume the typeName has been fully resolved already
        }

        if (!target) {
            throw Error('Not found: ' + typeName);
        }

        loaded[typeName] = target;
    }

    return target;
}

function getComponentClass(typeName) {
    var ComponentClass = componentTypes[typeName];

    if (ComponentClass) {
        return ComponentClass;
    }

    ComponentClass = load(typeName);

    ComponentClass = ComponentClass.Component || ComponentClass;

    if (!ComponentClass.___isComponent) {
        ComponentClass = defineComponent(ComponentClass, ComponentClass.renderer);
    }

    // Make the component "type" accessible on each component instance
    ComponentClass.prototype.___type = typeName;

    componentTypes[typeName] = ComponentClass;

    return ComponentClass;
}

function createComponent(typeName, id) {
    var ComponentClass = getComponentClass(typeName);
    return new ComponentClass(id);
}

exports.___register = register;
exports.___createComponent = createComponent;

});
$_mod.def("/marko$4.4.28/src/components/init-components-browser", function(require, exports, module, __filename, __dirname) { 'use strict';
var warp10Finalize = require('/warp10$1.3.6/finalize'/*'warp10/finalize'*/);
var eventDelegation = require('/marko$4.4.28/src/components/event-delegation'/*'./event-delegation'*/);
var win = window;
var defaultDocument = document;
var componentsUtil = require('/marko$4.4.28/src/components/util-browser'/*'./util'*/);
var componentLookup = componentsUtil.___componentLookup;
var getElementById = componentsUtil.___getElementById;
var ComponentDef = require('/marko$4.4.28/src/components/ComponentDef'/*'./ComponentDef'*/);
var registry = require('/marko$4.4.28/src/components/registry-browser'/*'./registry'*/);
var serverRenderedGlobals = {};

function invokeComponentEventHandler(component, targetMethodName, args) {
    var method = component[targetMethodName];
    if (!method) {
        throw Error('Method not found: ' + targetMethodName);
    }

    method.apply(component, args);
}

function addEventListenerHelper(el, eventType, listener) {
    el.addEventListener(eventType, listener, false);
    return function remove() {
        el.removeEventListener(eventType, listener);
    };
}

function addDOMEventListeners(component, el, eventType, targetMethodName, extraArgs, handles) {
    var removeListener = addEventListenerHelper(el, eventType, function(event) {
        var args = [event, el];
        if (extraArgs) {
            args = extraArgs.concat(args);
        }

        invokeComponentEventHandler(component, targetMethodName, args);
    });
    handles.push(removeListener);
}

function initComponent(componentDef, doc) {
    var component = componentDef.___component;

    if (!component || !component.___isComponent) {
        return; // legacy
    }

    component.___reset();
    component.___document = doc;

    var isExisting = componentDef.___isExisting;
    var id = component.id;

    var rootIds = componentDef.___roots;

    if (rootIds) {
        var rootComponents;

        var els = [];

        rootIds.forEach(function(rootId) {
            var nestedId = id + '-' + rootId;
            var rootComponent = componentLookup[nestedId];
            if (rootComponent) {
                rootComponent.___rootFor = component;
                if (rootComponents) {
                    rootComponents.push(rootComponent);
                } else {
                    rootComponents = component.___rootComponents = [rootComponent];
                }
            } else {
                var rootEl = getElementById(doc, nestedId);
                if (rootEl) {
                    rootEl._w = component;
                    els.push(rootEl);
                }
            }
        });

        component.el = els[0];
        component.els = els;
        componentLookup[id] = component;
    } else if (!isExisting) {
        var el = getElementById(doc, id);
        el._w = component;
        component.el = el;
        component.els = [el];
        componentLookup[id] = component;
    }

    if (componentDef.___willRerenderInBrowser) {
        component.___rerender(true);
        return;
    }

    if (isExisting) {
        component.___removeDOMEventListeners();
    }

    var domEvents = componentDef.___domEvents;
    if (domEvents) {
        var eventListenerHandles = [];

        domEvents.forEach(function(domEventArgs) {
            // The event mapping is for a direct DOM event (not a custom event and not for bubblign dom events)

            var eventType = domEventArgs[0];
            var targetMethodName = domEventArgs[1];
            var eventEl = getElementById(doc, domEventArgs[2]);
            var extraArgs = domEventArgs[3];

            addDOMEventListeners(component, eventEl, eventType, targetMethodName, extraArgs, eventListenerHandles);
        });

        if (eventListenerHandles.length) {
            component.___domEventListenerHandles = eventListenerHandles;
        }
    }

    if (component.___mounted) {
        component.___emitLifecycleEvent('update');
    } else {
        component.___mounted = true;
        component.___emitLifecycleEvent('mount');
    }
}

/**
 * This method is used to initialized components associated with UI components
 * rendered in the browser. While rendering UI components a "components context"
 * is added to the rendering context to keep up with which components are rendered.
 * When ready, the components can then be initialized by walking the component tree
 * in the components context (nested components are initialized before ancestor components).
 * @param  {Array<marko-components/lib/ComponentDef>} componentDefs An array of ComponentDef instances
 */
function initClientRendered(componentDefs, doc) {
    // Ensure that event handlers to handle delegating events are
    // always attached before initializing any components
    eventDelegation.___init(doc);

    doc = doc || defaultDocument;
    for (var i=0,len=componentDefs.length; i<len; i++) {
        var componentDef = componentDefs[i];

        if (componentDef.___children) {
            initClientRendered(componentDef.___children, doc);
        }

        initComponent(
            componentDef,
            doc);
    }
}

/**
 * This method initializes all components that were rendered on the server by iterating over all
 * of the component IDs.
 */
function initServerRendered(renderedComponents, doc) {
    if (!renderedComponents) {
        renderedComponents = win.$components;

        if (renderedComponents && renderedComponents.forEach) {
            renderedComponents.forEach(function(renderedComponent) {
                initServerRendered(renderedComponent, doc);
            });
        }

        win.$components = {
            concat: initServerRendered
        };

        return;
    }
    // Ensure that event handlers to handle delegating events are
    // always attached before initializing any components
    eventDelegation.___init(doc || defaultDocument);

    renderedComponents = warp10Finalize(renderedComponents);

    var componentDefs = renderedComponents.w;
    var typesArray = renderedComponents.t;
    var globals = window.$MG;
    if (globals) {
        serverRenderedGlobals = warp10Finalize(globals);
        delete window.$MG;
    }

    componentDefs.forEach(function(componentDef) {
        componentDef = ComponentDef.___deserialize(componentDef, typesArray, serverRenderedGlobals, registry);
        initComponent(componentDef, doc || defaultDocument);
    });
}

exports.___initClientRendered = initClientRendered;
exports.___initServerRendered = initServerRendered;

});
$_mod.def("/marko$4.4.28/src/components/boot", function(require, exports, module, __filename, __dirname) { require('/marko$4.4.28/src/components/init-components-browser'/*'./init-components'*/).___initServerRendered();
});
$_mod.run("/marko$4.4.28/src/components/boot");
$_mod.def("/marko$4.4.28/src/components/util-browser", function(require, exports, module, __filename, __dirname) { var extend = require('/raptor-util$3.2.0/extend'/*'raptor-util/extend'*/);

var markoGlobal = extend(window.$MG, {
  uid: 0
});

window.$MG = markoGlobal;

var runtimeId = markoGlobal.uid++;

var componentLookup = {};

var defaultDocument = document;
var EMPTY_OBJECT = {};

function getComponentForEl(el, doc) {
    if (el) {
        var node = typeof el == 'string' ? (doc || defaultDocument).getElementById(el) : el;
        if (node) {
            var component = node._w;

            while(component) {
                var rootFor = component.___rootFor;
                if (rootFor)  {
                    component = rootFor;
                } else {
                    break;
                }
            }

            return component;
        }
    }
}

var lifecycleEventMethods = {};

[
    'create',
    'render',
    'update',
    'mount',
    'destroy'
].forEach(function(eventName) {
    lifecycleEventMethods[eventName] = 'on' + eventName[0].toUpperCase() + eventName.substring(1);
});

/**
 * This method handles invoking a component's event handler method
 * (if present) while also emitting the event through
 * the standard EventEmitter.prototype.emit method.
 *
 * Special events and their corresponding handler methods
 * include the following:
 *
 * beforeDestroy --> onBeforeDestroy
 * destroy       --> onDestroy
 * beforeUpdate  --> onBeforeUpdate
 * update        --> onUpdate
 * render        --> onRender
 */
function emitLifecycleEvent(component, eventType, eventArg1, eventArg2) {
    var listenerMethod = component[lifecycleEventMethods[eventType]];

    if (listenerMethod !== undefined) {
        listenerMethod.call(component, eventArg1, eventArg2);
    }

    component.emit(eventType, eventArg1, eventArg2);
}

function destroyComponentForEl(el) {
    var componentToDestroy = el._w;
    if (componentToDestroy) {
        componentToDestroy.___destroyShallow();
        el._w = null;

        while ((componentToDestroy = componentToDestroy.___rootFor)) {
            componentToDestroy.___rootFor = null;
            componentToDestroy.___destroyShallow();
        }
    }
}
function destroyElRecursive(el) {
    var curChild = el.firstChild;
    while(curChild) {
        if (curChild.nodeType === 1) {
            destroyComponentForEl(curChild);
            destroyElRecursive(curChild);
        }
        curChild = curChild.nextSibling;
    }
}

function nextComponentId() {
    // Each component will get an ID that is unique across all loaded
    // marko runtimes. This allows multiple instances of marko to be
    // loaded in the same window and they should all place nice
    // together
    return 'b' + ((markoGlobal.uid)++);
}

function nextComponentIdProvider(out) {
    return nextComponentId;
}

function getElementById(doc, id) {
    return doc.getElementById(id);
}

function attachBubblingEvent(componentDef, handlerMethodName, extraArgs) {
    if (handlerMethodName) {
        var id = componentDef.id;
        if (extraArgs) {
            var isRerenderInBrowser = componentDef.___globalComponentsContext.___isRerenderInBrowser;

            if (isRerenderInBrowser === true) {
                // If we are bootstrapping a page rendered on the server
                // we need to put the actual event args on the UI component
                // since we will not actually be updating the DOM
                var component = componentDef.___component;

                var bubblingDomEvents = component.___bubblingDomEvents ||
                    ( component.___bubblingDomEvents = [] );

                bubblingDomEvents.push(extraArgs);

                return;
            } else {
                return [handlerMethodName, id, extraArgs];
            }
        } else {
            return [handlerMethodName, id];
        }
    }
}

function getMarkoPropsFromEl(el) {
    var virtualProps = el._vprops;
    if (virtualProps === undefined) {
        virtualProps = el.getAttribute('data-marko');
        if (virtualProps) {
            virtualProps = JSON.parse(virtualProps);
        }
        el._vprops = virtualProps = virtualProps || EMPTY_OBJECT;
    }

    return virtualProps;
}

exports.___runtimeId = runtimeId;
exports.___componentLookup = componentLookup;
exports.___getComponentForEl = getComponentForEl;
exports.___emitLifecycleEvent = emitLifecycleEvent;
exports.___destroyComponentForEl = destroyComponentForEl;
exports.___destroyElRecursive = destroyElRecursive;
exports.___nextComponentIdProvider = nextComponentIdProvider;
exports.___getElementById = getElementById;
exports.___attachBubblingEvent = attachBubblingEvent;
exports.___getMarkoPropsFromEl = getMarkoPropsFromEl;

});
$_mod.def("/marko$4.4.28/src/runtime/dom-insert", function(require, exports, module, __filename, __dirname) { var extend = require('/raptor-util$3.2.0/extend'/*'raptor-util/extend'*/);
var componentsUtil = require('/marko$4.4.28/src/components/util-browser'/*'../components/util'*/);
var destroyComponentForEl = componentsUtil.___destroyComponentForEl;
var destroyElRecursive = componentsUtil.___destroyElRecursive;

function resolveEl(el) {
    if (typeof el == 'string') {
        var elId = el;
        el = document.getElementById(elId);
        if (!el) {
            throw Error('Not found: ' + elId);
        }
    }
    return el;
}

function beforeRemove(referenceEl) {
    destroyElRecursive(referenceEl);
    destroyComponentForEl(referenceEl);
}

module.exports = function(target, getEl, afterInsert) {
    extend(target, {
        appendTo: function(referenceEl) {
            referenceEl = resolveEl(referenceEl);
            var el = getEl(this, referenceEl);
            referenceEl.appendChild(el);
            return afterInsert(this, referenceEl);
        },
        prependTo: function(referenceEl) {
            referenceEl = resolveEl(referenceEl);
            var el = getEl(this, referenceEl);
            referenceEl.insertBefore(el, referenceEl.firstChild || null);
            return afterInsert(this, referenceEl);
        },
        replace: function(referenceEl) {
            referenceEl = resolveEl(referenceEl);
            var el = getEl(this, referenceEl);
            beforeRemove(referenceEl);
            referenceEl.parentNode.replaceChild(el, referenceEl);
            return afterInsert(this, referenceEl);
        },
        replaceChildrenOf: function(referenceEl) {
            referenceEl = resolveEl(referenceEl);
            var el = getEl(this, referenceEl);

            var curChild = referenceEl.firstChild;
            while(curChild) {
                var nextSibling = curChild.nextSibling; // Just in case the DOM changes while removing
                if (curChild.nodeType == 1) {
                    beforeRemove(curChild);
                }
                curChild = nextSibling;
            }

            referenceEl.innerHTML = '';
            referenceEl.appendChild(el);
            return afterInsert(this, referenceEl);
        },
        insertBefore: function(referenceEl) {
            referenceEl = resolveEl(referenceEl);
            var el = getEl(this, referenceEl);
            referenceEl.parentNode.insertBefore(el, referenceEl);
            return afterInsert(this, referenceEl);
        },
        insertAfter: function(referenceEl) {
            referenceEl = resolveEl(referenceEl);
            var el = getEl(this, referenceEl);
            el = el;
            var nextSibling = referenceEl.nextSibling;
            var parentNode = referenceEl.parentNode;
            if (nextSibling) {
                parentNode.insertBefore(el, nextSibling);
            } else {
                parentNode.appendChild(el);
            }
            return afterInsert(this, referenceEl);
        }
    });
};

});
$_mod.def("/marko$4.4.28/src/runtime/RenderResult", function(require, exports, module, __filename, __dirname) { var domInsert = require('/marko$4.4.28/src/runtime/dom-insert'/*'./dom-insert'*/);

function getComponentDefs(result) {
    var componentDefs = result.___components;

    if (!componentDefs) {
        throw Error('No component');
    }
    return componentDefs;
}

function RenderResult(out) {
   this.out = this.___out = out;
   this.___components = undefined;
}

module.exports = RenderResult;

var proto = RenderResult.prototype = {
    getComponent: function() {
        return this.getComponents()[0];
    },
    getComponents: function(selector) {
        if (this.___components === undefined) {
            throw Error('Not added to DOM');
        }

        var componentDefs = getComponentDefs(this);

        var components = [];

        componentDefs.forEach(function(componentDef) {
            var component = componentDef.___component;
            if (!selector || selector(component)) {
                components.push(component);
            }
        });

        return components;
    },

    afterInsert: function(doc) {
        var out = this.___out;
        var globalComponentsContext = out.global.___components;
        if (globalComponentsContext) {
            this.___components = globalComponentsContext.___initComponents(doc);
        } else {
            this.___components = null;
        }

        return this;
    },
    getNode: function(doc) {
        return this.___out.___getNode(doc);
    },
    getOutput: function() {
        return this.___out.___getOutput();
    },
    toString: function() {
        return this.___out.toString();
    },
    document: typeof document != 'undefined' && document
};

// Add all of the following DOM methods to Component.prototype:
// - appendTo(referenceEl)
// - replace(referenceEl)
// - replaceChildrenOf(referenceEl)
// - insertBefore(referenceEl)
// - insertAfter(referenceEl)
// - prependTo(referenceEl)
domInsert(
    proto,
    function getEl(renderResult, referenceEl) {
        return renderResult.getNode(referenceEl.ownerDocument);
    },
    function afterInsert(renderResult, referenceEl) {
        return renderResult.afterInsert(referenceEl.ownerDocument);
    });

});
$_mod.def("/marko$4.4.28/src/runtime/vdom/AsyncVDOMBuilder", function(require, exports, module, __filename, __dirname) { var EventEmitter = require('/events-light$1.0.5/src/index'/*'events-light'*/);
var vdom = require('/marko$4.4.28/src/runtime/vdom/vdom'/*'./vdom'*/);
var VElement = vdom.___VElement;
var VDocumentFragment = vdom.___VDocumentFragment;
var VComment = vdom.___VComment;
var VText = vdom.___VText;
var virtualizeHTML = vdom.___virtualizeHTML;
var RenderResult = require('/marko$4.4.28/src/runtime/RenderResult'/*'../RenderResult'*/);
var defaultDocument = vdom.___defaultDocument;

var FLAG_FINISHED = 1;
var FLAG_LAST_FIRED = 2;

var EVENT_UPDATE = 'update';
var EVENT_FINISH = 'finish';

function State(tree) {
    this.___remaining = 1;
    this.___events = new EventEmitter();
    this.___tree = tree;
    this.___last = null;
    this.___lastCount = 0;
    this.___flags = 0;
}

function AsyncVDOMBuilder(globalData, parentNode, state) {
    if (!parentNode) {
        parentNode = new VDocumentFragment();
    }

    if (state) {
        state.___remaining++;
    } else {
        state = new State(parentNode);
    }

    this.data = {};
    this.___state = state;
    this.___parent = parentNode;
    this.global = globalData || {};
    this.___stack = [parentNode];
    this.___sync = false;
    this.___vnode = undefined;
    this.___componentArgs = null; // Component args
}

var proto = AsyncVDOMBuilder.prototype = {
    ___isOut: true,
    ___document: defaultDocument,

    ___elementNode: function(element, childCount, pushToStack) {
        var parent = this.___parent;
        if (parent !== undefined) {
            parent.___appendChild(element);
            if (pushToStack === true) {
                this.___stack.push(element);
                this.___parent = element;
            }
        }
        return childCount === 0 ? this : element;
    },

    element: function(tagName, attrs, childCount, flags, props) {
        var element = new VElement(tagName, attrs, childCount, flags, props);
        return this.___elementNode(element, childCount);
    },

    ___elementDynamicTag: function(tagName, attrs, childCount, flags, props) {
        var element = VElement.___createElementDynamicTag(tagName, attrs, childCount, flags, props);
        return this.___elementNode(element, childCount);
    },

    n: function(node) {
        // NOTE: We do a shallow clone since we assume the node is being reused
        //       and a node can only have one parent node.
        return this.node(node.___cloneNode());
    },

    node: function(node) {
        var parent = this.___parent;
        if (parent !== undefined) {
            parent.___appendChild(node);
        }
        return this;
    },

    text: function(text) {
        var type = typeof text;

        if (type != 'string') {
            if (text == null) {
                return;
            } else if (type === 'object') {
                if (text.toHTML) {
                    return this.h(text.toHTML());
                }
            }

            text = text.toString();
        }

        var parent = this.___parent;
        if (parent !== undefined) {
            var lastChild = parent.lastChild;
            if (lastChild && lastChild.___Text) {
                lastChild.___nodeValue += text;
            } else {
                parent.___appendChild(new VText(text));
            }
        }
        return this;
    },

    comment: function(comment) {
        return this.node(new VComment(comment));
    },

    html: function(html) {
        if (html != null) {
            var vdomNode = virtualizeHTML(html, this.___document || document);
            this.node(vdomNode);
        }

        return this;
    },

    beginElement: function(tagName, attrs, childCount, flags, props) {
        var element = new VElement(tagName, attrs, childCount, flags, props);
        this.___elementNode(element, childCount, true);
        return this;
    },

    ___beginElementDynamicTag: function(tagName, attrs, childCount, flags, props) {
        var element = VElement.___createElementDynamicTag(tagName, attrs, childCount, flags, props);
        this.___elementNode(element, childCount, true);
        return this;
    },

    endElement: function() {
        var stack = this.___stack;
        stack.pop();
        this.___parent = stack[stack.length-1];
    },

    end: function() {
        var state = this.___state;

        this.___parent = undefined;

        var remaining = --state.___remaining;

        if (!(state.___flags & FLAG_LAST_FIRED) && (remaining - state.___lastCount === 0)) {
            state.___flags |= FLAG_LAST_FIRED;
            state.___lastCount = 0;
            state.___events.emit('last');
        }

        if (remaining === 0) {
            state.___flags |= FLAG_FINISHED;
            state.___events.emit(EVENT_FINISH, this.___getResult());
        }

        return this;
    },

    error: function(e) {
        try {
            this.emit('error', e);
        } finally {
            // If there is no listener for the error event then it will
            // throw a new Error here. In order to ensure that the async fragment
            // is still properly ended we need to put the end() in a `finally`
            // block
            this.end();
        }

        return this;
    },

    beginAsync: function(options) {
        if (this.___sync) {
            throw Error('Not allowed');
        }

        var state = this.___state;

        if (options) {
            if (options.last) {
                state.___lastCount++;
            }
        }

        var documentFragment = this.___parent.___appendDocumentFragment();
        var asyncOut = new AsyncVDOMBuilder(this.global, documentFragment, state);

        state.___events.emit('beginAsync', {
           out: asyncOut,
           parentOut: this
       });

       return asyncOut;
    },

    createOut: function(callback) {
        return new AsyncVDOMBuilder(this.global);
    },

    flush: function() {
        var events = this.___state.___events;

        if (events.listenerCount(EVENT_UPDATE)) {
            events.emit(EVENT_UPDATE, new RenderResult(this));
        }
    },

    ___getOutput: function() {
        return this.___state.___tree;
    },

    ___getResult: function() {
        return this.___result || (this.___result = new RenderResult(this));
    },

    on: function(event, callback) {
        var state = this.___state;

        if (event === EVENT_FINISH && (state.___flags & FLAG_FINISHED)) {
            callback(this.___getResult());
        } else {
            state.___events.on(event, callback);
        }

        return this;
    },

    once: function(event, callback) {
        var state = this.___state;

        if (event === EVENT_FINISH && (state.___flags & FLAG_FINISHED)) {
            callback(this.___getResult());
            return this;
        }

        state.___events.once(event, callback);
        return this;
    },

    emit: function(type, arg) {
        var events = this.___state.___events;
        switch(arguments.length) {
            case 1:
                events.emit(type);
                break;
            case 2:
                events.emit(type, arg);
                break;
            default:
                events.emit.apply(events, arguments);
                break;
        }
        return this;
    },

    removeListener: function() {
        var events = this.___state.___events;
        events.removeListener.apply(events, arguments);
        return this;
    },

    sync: function() {
        this.___sync = true;
    },

    isSync: function() {
        return this.___sync;
    },

    onLast: function(callback) {
        var state = this.___state;

        var lastArray = state.___last;

        if (!lastArray) {
            lastArray = state.___last = [];
            var i = 0;
            var next = function() {
                if (i === lastArray.length) {
                    return;
                }
                var _next = lastArray[i++];
                _next(next);
            };

            this.once('last', function() {
                next();
            });
        }

        lastArray.push(callback);
        return this;
    },

    ___getNode: function(doc) {
        var node = this.___vnode;
        if (!node) {
            var vdomTree = this.___getOutput();

            node = this.___vnode = vdomTree.actualize(doc || this.___document || document);
        }
        return node;
    },

    toString: function() {
        var docFragment = this.___getNode();
        var html = '';

        if (docFragment.hasChildNodes()) {
            var children = docFragment.childNodes;
            for (var i = 0; i < children.length; i++) {
                var child = children[i];
                // get outerHTML if exists, otherwise default to nodeValue
                html += child.outerHTML || child.nodeValue;
            }
        }

        return html;
    },

    then: function(fn, fnErr) {
        var out = this;
        var promise = new Promise(function(resolve, reject) {
            out.on('error', reject)
                .on(EVENT_FINISH, function(result) {
                    resolve(result);
                });
        });

        return Promise.resolve(promise).then(fn, fnErr);
    },

    catch: function(fnErr) {
        return this.then(undefined, fnErr);
    },

    isVDOM: true,

    c: function(componentArgs) {
        this.___componentArgs = componentArgs;
    }
};

proto.e = proto.element;
proto.ed = proto.___elementDynamicTag;
proto.be = proto.beginElement;
proto.bed = proto.___beginElementDynamicTag;
proto.ee = proto.endElement;
proto.t = proto.text;
proto.h = proto.w = proto.write = proto.html;

module.exports = AsyncVDOMBuilder;

});
$_mod.def("/marko$4.4.28/src/runtime/renderable", function(require, exports, module, __filename, __dirname) { var defaultCreateOut = require('/marko$4.4.28/src/runtime/createOut'/*'./createOut'*/);
var extend = require('/raptor-util$3.2.0/extend'/*'raptor-util/extend'*/);

function safeRender(renderFunc, finalData, finalOut, shouldEnd) {
    try {
        renderFunc(finalData, finalOut);

        if (shouldEnd) {
            finalOut.end();
        }
    } catch(err) {
        var actualEnd = finalOut.end;
        finalOut.end = function() {};

        setTimeout(function() {
            finalOut.end = actualEnd;
            finalOut.error(err);
        }, 0);
    }
    return finalOut;
}

module.exports = function(target, renderer) {
    var renderFunc = renderer && (renderer.renderer || renderer.render || renderer);
    var createOut = target.createOut || renderer.createOut || defaultCreateOut;

    return extend(target, {
        createOut: createOut,

        renderToString: function(data, callback) {
            var localData = data || {};
            var render = renderFunc || this._;
            var globalData = localData.$global;
            var out = createOut(globalData);

            out.global.template = this;

            if (globalData) {
                localData.$global = undefined;
            }

            if (callback) {
                out.on('finish', function() {
                       callback(null, out.toString(), out);
                   })
                   .once('error', callback);

                return safeRender(render, localData, out, true);
            } else {
                out.sync();
                render(localData, out);
                return out.toString();
            }
        },

        renderSync: function(data) {
            var localData = data || {};
            var render = renderFunc || this._;
            var globalData = localData.$global;
            var out = createOut(globalData);
            out.sync();

            out.global.template = this;

            if (globalData) {
                localData.$global = undefined;
            }

            render(localData, out);
            return out.___getResult();
        },

        /**
         * Renders a template to either a stream (if the last
         * argument is a Stream instance) or
         * provides the output to a callback function (if the last
         * argument is a Function).
         *
         * Supported signatures:
         *
         * render(data)
         * render(data, out)
         * render(data, stream)
         * render(data, callback)
         *
         * @param  {Object} data The view model data for the template
         * @param  {AsyncStream/AsyncVDOMBuilder} out A Stream, an AsyncStream/AsyncVDOMBuilder instance, or a callback function
         * @return {AsyncStream/AsyncVDOMBuilder} Returns the AsyncStream/AsyncVDOMBuilder instance that the template is rendered to
         */
        render: function(data, out) {
            var callback;
            var finalOut;
            var finalData;
            var globalData;
            var render = renderFunc || this._;
            var shouldBuffer = this.___shouldBuffer;
            var shouldEnd = true;

            if (data) {
                finalData = data;
                if ((globalData = data.$global)) {
                    finalData.$global = undefined;
                }
            } else {
                finalData = {};
            }

            if (out && out.___isOut) {
                finalOut = out;
                shouldEnd = false;
                extend(out.global, globalData);
            } else if (typeof out == 'function') {
                finalOut = createOut(globalData);
                callback = out;
            } else {
                finalOut = createOut(
                    globalData, // global
                    out, // writer(AsyncStream) or parentNode(AsyncVDOMBuilder)
                    null, // state
                    shouldBuffer // ignored by AsyncVDOMBuilder
                );
            }

            if (callback) {
                finalOut
                    .on('finish', function() {
                        callback(null, finalOut.___getResult());
                    })
                    .once('error', callback);
            }

            globalData = finalOut.global;

            globalData.template = globalData.template || this;

            return safeRender(render, finalData, finalOut, shouldEnd);
        }
    });
};

});
$_mod.def("/marko$4.4.28/src/runtime/vdom/index", function(require, exports, module, __filename, __dirname) { 'use strict';
require('/marko$4.4.28/src/index-browser'/*'../../'*/);

// helpers provide a core set of various utility methods
// that are available in every template
var AsyncVDOMBuilder = require('/marko$4.4.28/src/runtime/vdom/AsyncVDOMBuilder'/*'./AsyncVDOMBuilder'*/);
var makeRenderable = require('/marko$4.4.28/src/runtime/renderable'/*'../renderable'*/);

/**
 * Method is for internal usage only. This method
 * is invoked by code in a compiled Marko template and
 * it is used to create a new Template instance.
 * @private
 */
exports.t = function createTemplate(path) {
     return new Template(path);
};

function Template(path, func) {
    this.path = path;
    this._ = func;
    this.meta = undefined;
}

function createOut(globalData, parent, state) {
    return new AsyncVDOMBuilder(globalData, parent, state);
}

var Template_prototype = Template.prototype = {
    createOut: createOut
};

makeRenderable(Template_prototype);

exports.Template = Template;
exports.___createOut = createOut;

require('/marko$4.4.28/src/runtime/createOut'/*'../createOut'*/).___setCreateOut(createOut);

});
$_mod.def("/marko$4.4.28/src/vdom", function(require, exports, module, __filename, __dirname) { module.exports = require('/marko$4.4.28/src/runtime/vdom/index'/*'./runtime/vdom'*/);

});
$_mod.remap("/marko$4.4.28/src/components/helpers", "/marko$4.4.28/src/components/helpers-browser");
$_mod.main("/marko$4.4.28/src/components", "");
$_mod.remap("/marko$4.4.28/src/components/index", "/marko$4.4.28/src/components/index-browser");
$_mod.def("/marko$4.4.28/src/components/index-browser", function(require, exports, module, __filename, __dirname) { var componentsUtil = require('/marko$4.4.28/src/components/util-browser'/*'./util'*/);
var initComponents = require('/marko$4.4.28/src/components/init-components-browser'/*'./init-components'*/);

require('/marko$4.4.28/src/components/ComponentsContext'/*'./ComponentsContext'*/).___initClientRendered = initComponents.___initClientRendered;

exports.getComponentForEl = componentsUtil.___getComponentForEl;
exports.init = initComponents.___initServerRendered;

});
$_mod.def("/marko$4.4.28/src/components/renderer", function(require, exports, module, __filename, __dirname) { var componentsUtil = require('/marko$4.4.28/src/components/util-browser'/*'./util'*/);
var componentLookup = componentsUtil.___componentLookup;
var emitLifecycleEvent = componentsUtil.___emitLifecycleEvent;

var ComponentsContext = require('/marko$4.4.28/src/components/ComponentsContext'/*'./ComponentsContext'*/);
var getComponentsContext = ComponentsContext.___getComponentsContext;
var repeatedRegExp = /\[\]$/;
var registry = require('/marko$4.4.28/src/components/registry-browser'/*'./registry'*/);
var copyProps = require('/raptor-util$3.2.0/copyProps'/*'raptor-util/copyProps'*/);
var isServer = componentsUtil.___isServer === true;

var COMPONENT_BEGIN_ASYNC_ADDED_KEY = '$wa';

function resolveComponentKey(globalComponentsContext, key, scope) {
    if (key[0] == '#') {
        return key.substring(1);
    } else {
        var resolvedId;

        if (repeatedRegExp.test(key)) {
            resolvedId = globalComponentsContext.___nextRepeatedId(scope, key);
        } else {
            resolvedId = scope + '-' + key;
        }

        return resolvedId;
    }
}

function preserveComponentEls(existingComponent, out, globalComponentsContext) {
    var rootEls = existingComponent.___getRootEls({});

    for (var elId in rootEls) {
        var el = rootEls[elId];

        // We put a placeholder element in the output stream to ensure that the existing
        // DOM node is matched up correctly when using morphdom.
        out.element(el.tagName, { id: elId });

        globalComponentsContext.___preserveDOMNode(elId); // Mark the element as being preserved (for morphdom)
    }

    existingComponent.___reset(); // The component is no longer dirty so reset internal flags
    return true;
}

function handleBeginAsync(event) {
    var parentOut = event.parentOut;
    var asyncOut = event.out;
    var componentsContext = parentOut.data.___components;

    if (componentsContext !== undefined) {
        // All of the components in this async block should be
        // initialized after the components in the parent. Therefore,
        // we will create a new ComponentsContext for the nested
        // async block and will create a new component stack where the current
        // component in the parent block is the only component in the nested
        // stack (to begin with). This will result in top-level components
        // of the async block being added as children of the component in the
        // parent block.
        var nestedComponentsContext = componentsContext.___createNestedComponentsContext(asyncOut);
        asyncOut.data.___components = nestedComponentsContext;
    }
    // Carry along the component arguments
    asyncOut.___componentArgs = parentOut.___componentArgs;
}

function createRendererFunc(templateRenderFunc, componentProps, renderingLogic) {
    renderingLogic = renderingLogic || {};
    var onInput = renderingLogic.onInput;
    var typeName = componentProps.type;
    var roots = componentProps.roots;
    var assignedId = componentProps.id;
    var isSplit = componentProps.split === true;
    var shouldApplySplitMixins = isSplit;

    return function renderer(input, out) {
        var outGlobal = out.global;

        if (out.isSync() === false) {
            if (!outGlobal[COMPONENT_BEGIN_ASYNC_ADDED_KEY]) {
                outGlobal[COMPONENT_BEGIN_ASYNC_ADDED_KEY] = true;
                out.on('beginAsync', handleBeginAsync);
            }
        }

        var componentsContext = getComponentsContext(out);
        var globalComponentsContext = componentsContext.___globalContext;

        var component = globalComponentsContext.___rerenderComponent;
        var isRerender = component !== undefined;
        var id = assignedId;
        var isExisting;
        var customEvents;
        var scope;

        if (component) {
            id = component.id;
            isExisting = true;
            globalComponentsContext.___rerenderComponent = null;
        } else {
            var componentArgs = out.___componentArgs;

            if (componentArgs) {
                out.___componentArgs = null;

                scope = componentArgs[0];

                if (scope) {
                    scope = scope.id;
                }

                var key = componentArgs[1];
                if (key != null) {
                    key = key.toString();
                }
                id = id || resolveComponentKey(globalComponentsContext, key, scope);
                customEvents = componentArgs[2];
            }
        }

        id = id || componentsContext.___nextComponentId();

        if (isServer) {
            component = registry.___createComponent(
                renderingLogic,
                id,
                input,
                out,
                typeName,
                customEvents,
                scope);
            input = component.___updatedInput;
            component.___updatedInput = undefined; // We don't want ___updatedInput to be serialized to the browser
        } else {
            if (!component) {
                if (isRerender) {
                    // Look in in the DOM to see if a component with the same ID and type already exists.
                    component = componentLookup[id];
                    if (component && component.___type !== typeName) {
                        component = undefined;
                    }
                }

                if (component) {
                    isExisting = true;
                } else {
                    isExisting = false;
                    // We need to create a new instance of the component
                    component = registry.___createComponent(typeName, id);

                    if (shouldApplySplitMixins === true) {
                        shouldApplySplitMixins = false;

                        var renderingLogicProps = typeof renderingLogic == 'function' ?
                            renderingLogic.prototype :
                            renderingLogic;

                        copyProps(renderingLogicProps, component.constructor.prototype);
                    }
                }

                // Set this flag to prevent the component from being queued for update
                // based on the new input. The component is about to be rerendered
                // so we don't want to queue it up as a result of calling `setInput()`
                component.___updateQueued = true;

                if (customEvents !== undefined) {
                    component.___setCustomEvents(customEvents, scope);
                }


                if (isExisting === false) {
                    emitLifecycleEvent(component, 'create', input, out);
                }

                input = component.___setInput(input, onInput, out);

                if (isExisting === true) {
                    if (component.___isDirty === false || component.shouldUpdate(input, component.___state) === false) {
                        preserveComponentEls(component, out, globalComponentsContext);
                        return;
                    }
                }
            }

            component.___global = outGlobal;

            emitLifecycleEvent(component, 'render', out);
        }

        var componentDef = componentsContext.___beginComponent(component, isSplit);
        componentDef.___roots = roots;
        componentDef.___isExisting = isExisting;

        // Render the template associated with the component using the final template
        // data that we constructed
        templateRenderFunc(input, out, componentDef, component, component.___rawState);

        componentDef.___end();
    };
}

module.exports = createRendererFunc;

// exports used by the legacy renderer
createRendererFunc.___resolveComponentKey = resolveComponentKey;
createRendererFunc.___preserveComponentEls = preserveComponentEls;
createRendererFunc.___handleBeginAsync = handleBeginAsync;

});
$_mod.def("/marko$4.4.28/src/components/helpers-browser", function(require, exports, module, __filename, __dirname) { require('/marko$4.4.28/src/components/index-browser'/*'./'*/);

exports.c = require('/marko$4.4.28/src/components/defineComponent'/*'./defineComponent'*/); // Referenced by compiled templates
exports.r = require('/marko$4.4.28/src/components/renderer'/*'./renderer'*/); // Referenced by compiled templates
exports.rc = require('/marko$4.4.28/src/components/registry-browser'/*'./registry'*/).___register;  // Referenced by compiled templates

});
$_mod.searchPath("/myebaynode$1.0.0/");
$_mod.main("/myebaynode$1.0.0/src/common-utils/pubsub", "");
$_mod.installed("myebaynode$1.0.0", "raptor-pubsub", "1.0.5");
$_mod.def("/myebaynode$1.0.0/src/common-utils/pubsub/eventRegistry", function(require, exports, module, __filename, __dirname) { 'use strict';

const defaultChannel = 'DEFAULT_CHANNEL';

/**
 * Event Registry is an enum of pubsub events and their associated channels.
 * The key is the event name and the value is the channel
 * For events that need to be emitted and listened on the global channel,
 * specify 'GLOBAL' as the channel value.
 */
const eventRegistry = {
    'INLINE_REFRESH': 'INLINE_REFRESH'
};

module.exports = {
    getChannel: function(eventName) {
        return eventRegistry[eventName] || defaultChannel;
    }
};

module.exports.privates = {
    eventRegistry: eventRegistry,
    defaultChannel: defaultChannel
};

});
$_mod.def("/myebaynode$1.0.0/src/common-utils/pubsub/index", function(require, exports, module, __filename, __dirname) { 'use strict';

const raptorPubsub = require('/raptor-pubsub$1.0.5/lib/index'/*'raptor-pubsub'*/);

const eventRegistry = require('/myebaynode$1.0.0/src/common-utils/pubsub/eventRegistry'/*'./eventRegistry'*/);

/**
 * Creating pubsub channels. Returns global channel if channel name is 'GLOBAL'
 * @param  {string} channelName [Channel Name]
 * @return {Object}             [Pubsub Channel object]
 */
function createChannel(channelName) {
    let channel;
    if (channelName === 'GLOBAL') {
        channel = raptorPubsub;
    } else {
        channel = raptorPubsub.channel(channelName);
    }
    channel.name = channelName;
    return channel;
}

/**
 * A dictionary of context bound pubsub listeners. See README for more details.
 */
const ctxBoundHandlers = {};

function findOrAdd(eventArg, callback, ctx, channel) {
    let list = ctxBoundHandlers[eventArg];
    let cb;
    let i;
    let len = 0;
    let binding = {};

    if (!list) {
        list = [];
        ctxBoundHandlers[eventArg] = list;
    }

    len = list.length;
    for (i = 0; i < len; i += 1) {
        if (ctx.id === list[i].ctx.id) {
            cb = list[i].cb;
            break;
        }
    }
    if (cb) {
        console.warn(`[PUBSUB-ON-WARN]: The event "${eventArg}" is already registered`);
        return;
    }

    cb = function() {
        callback.apply(ctx, arguments);
    };
    binding = {
        ctx: ctx,
        cb: cb
    };
    list.push(binding);
    channel.on(eventArg, cb);
}

function findAndRemove(eventArg, callback, ctx, channel) {
    const list = ctxBoundHandlers[eventArg] || [];
    let i;
    const len = list.length;
    let cb;

    for (i = 0; i < len; i += 1) {
        if (ctx.id === list[i].ctx.id) {
            cb = list[i].cb;
            break;
        }
    }
    if (cb) {
        list.splice(i, 1);
        channel.removeListener(eventArg, cb);
    } else {
        console.warn(`[PUBSUB-OFF-WARN]: The handler for "${eventArg}" was not found`);
        if (callback) {
            channel.removeListener(eventArg, callback);
        }
    }
}

const pubsub = {
    /**
     * Handler for attaching event handlers to listeners
     * @param  {string}   eventArg [Event name]
     * @param  {Function} callback [Event handler as callback]
     * @param  {Object} context for the callback method, optional
     * @return {void}
     */
    on: function(eventArg, callback, ctx) {
        if (typeof callback !== 'function') {
            console.error(`[PUBSUB-ON-ERROR]: Callback passed for event "${eventArg}" is not a function`);
            return this;
        }
        if (ctx && !ctx.id) {
            console.warn(`[PUBSUB-ON-WARN]: Context without an id is ignored: eventArg "${eventArg}`);
        }

        // Getting channel name for given event
        const channelName = eventRegistry.getChannel(eventArg);

        // Creating pubsub channel
        const channel = createChannel(channelName);

        // Listening to event
        if (ctx && ctx.id) {
            findOrAdd(eventArg, callback, ctx, channel);
        } else {
            channel.on(eventArg, callback);
        }
        return this;
    },

    /**
     * Detach event handlers
     * @param  {string}   eventArg [Event name]
     * @param  {Function} callback [Event handler as callback]
     * @param  {Object} context for the callback method, when a valid context is provided, callback is optional
     * @return {void}
     */
    off: function(eventArg, callback, ctx) {
        const channelName = eventRegistry.getChannel(eventArg);
        const channel = createChannel(channelName);

        if (ctx && !ctx.id) {
            console.warn(`[PUBSUB-OFF-WARN]: Context without an id is ignored: eventArg "${eventArg}`);
        }
        if (ctx && ctx.id) {
            findAndRemove(eventArg, callback, ctx, channel);
        } else if (callback) {
            channel.removeListener(eventArg, callback);
        }
        return this;
    },

    /**
     * Handler for emitting events and event data
     * @param  {string} eventArg [Event name]
     * @param  {Object} dataArg  [Event data]
     * @return {void}
     */
    emit: function(eventArg, dataArg) {
        // Getting channel name for given event
        const channelName = eventRegistry.getChannel(eventArg);

        // Creating pubsub channel
        const channel = createChannel(channelName);

        // Emitting event and event data
        channel.emit(eventArg, dataArg);
        return this;
    }
};

module.exports = pubsub;

module.exports.privates = {
    createChannel: createChannel
};

});
$_mod.def("/myebaynode$1.0.0/src/fe-components/m-common/component", function(require, exports, module, __filename, __dirname) { 'use strict';
const pubsub = require('/myebaynode$1.0.0/src/common-utils/pubsub/index'/*'src/common-utils/pubsub'*/);

module.exports = {
    onMount() {
        this.container = this.getEl('common-wrapper');
        this.pubsubRegister();
        this.attachEvents();
    },
    pubsubRegister() {
        pubsub.on('SHOW_MASK', this.showMask, this);
        pubsub.on('HIDE_MASK', this.hideMask, this);
    },
    attachEvents() {
        $(document).ready(() => {
            $(document).on('click', (e) => {
                if ($(e.target).closest('.m-menu').length > 0) {
                    $(".m-menu").not($(e.target).closest('.m-menu')).find('.menu__btn').attr('aria-expanded', false);
                } else if ($(e.target).closest('.m-menu').length === 0) {
                    $('.m-menu .menu__btn').attr('aria-expanded', false);
                }
                if ($(e.target).closest('.m-middle-header__lists').length === 0) {
                    $(".m-middle-header__title").attr('aria-expanded', false);
                }
            });
        });
    },
    showMask() {
        $(this.container).find('.dialog__mask--fade').removeClass('hide');
    },
    hideMask() {
        $(this.container).find('.dialog__mask--fade').addClass('hide');
    }
};


module.exports.privates = {

};

});
$_mod.main("/myebaynode$1.0.0/src/fe-components/m-lazy", "index.marko");
$_mod.def("/marko$4.4.28/src/runtime/helpers", function(require, exports, module, __filename, __dirname) { 'use strict';
var isArray = Array.isArray;

function isFunction(arg) {
    return typeof arg == 'function';
}

function classList(arg, classNames) {
    var len;

    if (arg) {
        if (typeof arg == 'string') {
            if (arg) {
                classNames.push(arg);
            }
        } else if (typeof (len = arg.length) == 'number') {
            for (var i=0; i<len; i++) {
                classList(arg[i], classNames);
            }
        } else if (typeof arg == 'object') {
            for (var name in arg) {
                if (arg.hasOwnProperty(name)) {
                    var value = arg[name];
                    if (value) {
                        classNames.push(name);
                    }
                }
            }
        }
    }
}

function createDeferredRenderer(handler) {
    function deferredRenderer(input, out) {
        deferredRenderer.renderer(input, out);
    }

    // This is the initial function that will do the rendering. We replace
    // the renderer with the actual renderer func on the first render
    deferredRenderer.renderer = function(input, out) {
        var rendererFunc = handler.renderer || handler._ || handler.render;
        if (!isFunction(rendererFunc)) {
            throw Error('Invalid renderer');
        }
        // Use the actual renderer from now on
        deferredRenderer.renderer = rendererFunc;
        rendererFunc(input, out);
    };

    return deferredRenderer;
}

function resolveRenderer(handler) {
    var renderer = handler.renderer || handler._;

    if (renderer) {
        return renderer;
    }

    if (isFunction(handler)) {
        return handler;
    }

    // If the user code has a circular function then the renderer function
    // may not be available on the module. Since we can't get a reference
    // to the actual renderer(input, out) function right now we lazily
    // try to get access to it later.
    return createDeferredRenderer(handler);
}

var helpers = {
    /**
     * Internal helper method to prevent null/undefined from being written out
     * when writing text that resolves to null/undefined
     * @private
     */
    s: function strHelper(str) {
        return (str == null) ? '' : str.toString();
    },

    /**
     * Internal helper method to handle loops without a status variable
     * @private
     */
    f: function forEachHelper(array, callback) {
        if (isArray(array)) {
            for (var i=0; i<array.length; i++) {
                callback(array[i]);
            }
        } else if (isFunction(array)) {
            // Also allow the first argument to be a custom iterator function
            array(callback);
        }
    },

    /**
     * Helper to load a custom tag
     */
    t: function loadTagHelper(renderer, targetProperty, isRepeated) {
        if (renderer) {
            renderer = resolveRenderer(renderer);
        }

        return renderer;
    },

    /**
     * classList(a, b, c, ...)
     * Joines a list of class names with spaces. Empty class names are omitted.
     *
     * classList('a', undefined, 'b') --> 'a b'
     *
     */
    cl: function classListHelper() {
        var classNames = [];
        classList(arguments, classNames);
        return classNames.join(' ');
    }
};

module.exports = helpers;

});
$_mod.def("/marko$4.4.28/src/runtime/vdom/helpers", function(require, exports, module, __filename, __dirname) { 'use strict';

var vdom = require('/marko$4.4.28/src/runtime/vdom/vdom'/*'./vdom'*/);
var VElement = vdom.___VElement;
var VText = vdom.___VText;

var commonHelpers = require('/marko$4.4.28/src/runtime/helpers'/*'../helpers'*/);
var extend = require('/raptor-util$3.2.0/extend'/*'raptor-util/extend'*/);

var classList = commonHelpers.cl;

var helpers = extend({
    e: function(tagName, attrs, childCount, flags, props) {
        return new VElement(tagName, attrs, childCount, flags, props);
    },

    t: function(value) {
        return new VText(value);
    },

    const: function(id) {
        var i=0;
        return function() {
            return id + (i++);
        };
    },

    /**
     * Internal helper method to handle the "class" attribute. The value can either
     * be a string, an array or an object. For example:
     *
     * ca('foo bar') ==> ' class="foo bar"'
     * ca({foo: true, bar: false, baz: true}) ==> ' class="foo baz"'
     * ca(['foo', 'bar']) ==> ' class="foo bar"'
     */
    ca: function(classNames) {
        if (!classNames) {
            return null;
        }

        if (typeof classNames === 'string') {
            return classNames;
        } else {
            return classList(classNames);
        }
    }
}, commonHelpers);

module.exports = helpers;

});
$_mod.installed("myebaynode$1.0.0", "lasso", "2.11.24");
$_mod.remap("/lasso$2.11.24/taglib/slot-tag", "/lasso$2.11.24/taglib/noop-render");
$_mod.def("/lasso$2.11.24/taglib/noop-render", function(require, exports, module, __filename, __dirname) { // Use as a noop in the browser for taglibs
module.exports = function render(input, out) {};

});
$_mod.installed("myebaynode$1.0.0", "@ebay/retriever", "1.0.0");
$_mod.main("/@ebay/retriever$1.0.0", "");
$_mod.installed("@ebay/retriever$1.0.0", "lodash.get", "4.4.2");
$_mod.main("/lodash.get$4.4.2", "");
$_mod.def("/lodash.get$4.4.2/index", function(require, exports, module, __filename, __dirname) { /**
 * lodash (Custom Build) <https://lodash.com/>
 * Build: `lodash modularize exports="npm" -o ./`
 * Copyright jQuery Foundation and other contributors <https://jquery.org/>
 * Released under MIT license <https://lodash.com/license>
 * Based on Underscore.js 1.8.3 <http://underscorejs.org/LICENSE>
 * Copyright Jeremy Ashkenas, DocumentCloud and Investigative Reporters & Editors
 */

/** Used as the `TypeError` message for "Functions" methods. */
var FUNC_ERROR_TEXT = 'Expected a function';

/** Used to stand-in for `undefined` hash values. */
var HASH_UNDEFINED = '__lodash_hash_undefined__';

/** Used as references for various `Number` constants. */
var INFINITY = 1 / 0;

/** `Object#toString` result references. */
var funcTag = '[object Function]',
    genTag = '[object GeneratorFunction]',
    symbolTag = '[object Symbol]';

/** Used to match property names within property paths. */
var reIsDeepProp = /\.|\[(?:[^[\]]*|(["'])(?:(?!\1)[^\\]|\\.)*?\1)\]/,
    reIsPlainProp = /^\w*$/,
    reLeadingDot = /^\./,
    rePropName = /[^.[\]]+|\[(?:(-?\d+(?:\.\d+)?)|(["'])((?:(?!\2)[^\\]|\\.)*?)\2)\]|(?=(?:\.|\[\])(?:\.|\[\]|$))/g;

/**
 * Used to match `RegExp`
 * [syntax characters](http://ecma-international.org/ecma-262/7.0/#sec-patterns).
 */
var reRegExpChar = /[\\^$.*+?()[\]{}|]/g;

/** Used to match backslashes in property paths. */
var reEscapeChar = /\\(\\)?/g;

/** Used to detect host constructors (Safari). */
var reIsHostCtor = /^\[object .+?Constructor\]$/;

/** Detect free variable `global` from Node.js. */
var freeGlobal = typeof global == 'object' && global && global.Object === Object && global;

/** Detect free variable `self`. */
var freeSelf = typeof self == 'object' && self && self.Object === Object && self;

/** Used as a reference to the global object. */
var root = freeGlobal || freeSelf || Function('return this')();

/**
 * Gets the value at `key` of `object`.
 *
 * @private
 * @param {Object} [object] The object to query.
 * @param {string} key The key of the property to get.
 * @returns {*} Returns the property value.
 */
function getValue(object, key) {
  return object == null ? undefined : object[key];
}

/**
 * Checks if `value` is a host object in IE < 9.
 *
 * @private
 * @param {*} value The value to check.
 * @returns {boolean} Returns `true` if `value` is a host object, else `false`.
 */
function isHostObject(value) {
  // Many host objects are `Object` objects that can coerce to strings
  // despite having improperly defined `toString` methods.
  var result = false;
  if (value != null && typeof value.toString != 'function') {
    try {
      result = !!(value + '');
    } catch (e) {}
  }
  return result;
}

/** Used for built-in method references. */
var arrayProto = Array.prototype,
    funcProto = Function.prototype,
    objectProto = Object.prototype;

/** Used to detect overreaching core-js shims. */
var coreJsData = root['__core-js_shared__'];

/** Used to detect methods masquerading as native. */
var maskSrcKey = (function() {
  var uid = /[^.]+$/.exec(coreJsData && coreJsData.keys && coreJsData.keys.IE_PROTO || '');
  return uid ? ('Symbol(src)_1.' + uid) : '';
}());

/** Used to resolve the decompiled source of functions. */
var funcToString = funcProto.toString;

/** Used to check objects for own properties. */
var hasOwnProperty = objectProto.hasOwnProperty;

/**
 * Used to resolve the
 * [`toStringTag`](http://ecma-international.org/ecma-262/7.0/#sec-object.prototype.tostring)
 * of values.
 */
var objectToString = objectProto.toString;

/** Used to detect if a method is native. */
var reIsNative = RegExp('^' +
  funcToString.call(hasOwnProperty).replace(reRegExpChar, '\\$&')
  .replace(/hasOwnProperty|(function).*?(?=\\\()| for .+?(?=\\\])/g, '$1.*?') + '$'
);

/** Built-in value references. */
var Symbol = root.Symbol,
    splice = arrayProto.splice;

/* Built-in method references that are verified to be native. */
var Map = getNative(root, 'Map'),
    nativeCreate = getNative(Object, 'create');

/** Used to convert symbols to primitives and strings. */
var symbolProto = Symbol ? Symbol.prototype : undefined,
    symbolToString = symbolProto ? symbolProto.toString : undefined;

/**
 * Creates a hash object.
 *
 * @private
 * @constructor
 * @param {Array} [entries] The key-value pairs to cache.
 */
function Hash(entries) {
  var index = -1,
      length = entries ? entries.length : 0;

  this.clear();
  while (++index < length) {
    var entry = entries[index];
    this.set(entry[0], entry[1]);
  }
}

/**
 * Removes all key-value entries from the hash.
 *
 * @private
 * @name clear
 * @memberOf Hash
 */
function hashClear() {
  this.__data__ = nativeCreate ? nativeCreate(null) : {};
}

/**
 * Removes `key` and its value from the hash.
 *
 * @private
 * @name delete
 * @memberOf Hash
 * @param {Object} hash The hash to modify.
 * @param {string} key The key of the value to remove.
 * @returns {boolean} Returns `true` if the entry was removed, else `false`.
 */
function hashDelete(key) {
  return this.has(key) && delete this.__data__[key];
}

/**
 * Gets the hash value for `key`.
 *
 * @private
 * @name get
 * @memberOf Hash
 * @param {string} key The key of the value to get.
 * @returns {*} Returns the entry value.
 */
function hashGet(key) {
  var data = this.__data__;
  if (nativeCreate) {
    var result = data[key];
    return result === HASH_UNDEFINED ? undefined : result;
  }
  return hasOwnProperty.call(data, key) ? data[key] : undefined;
}

/**
 * Checks if a hash value for `key` exists.
 *
 * @private
 * @name has
 * @memberOf Hash
 * @param {string} key The key of the entry to check.
 * @returns {boolean} Returns `true` if an entry for `key` exists, else `false`.
 */
function hashHas(key) {
  var data = this.__data__;
  return nativeCreate ? data[key] !== undefined : hasOwnProperty.call(data, key);
}

/**
 * Sets the hash `key` to `value`.
 *
 * @private
 * @name set
 * @memberOf Hash
 * @param {string} key The key of the value to set.
 * @param {*} value The value to set.
 * @returns {Object} Returns the hash instance.
 */
function hashSet(key, value) {
  var data = this.__data__;
  data[key] = (nativeCreate && value === undefined) ? HASH_UNDEFINED : value;
  return this;
}

// Add methods to `Hash`.
Hash.prototype.clear = hashClear;
Hash.prototype['delete'] = hashDelete;
Hash.prototype.get = hashGet;
Hash.prototype.has = hashHas;
Hash.prototype.set = hashSet;

/**
 * Creates an list cache object.
 *
 * @private
 * @constructor
 * @param {Array} [entries] The key-value pairs to cache.
 */
function ListCache(entries) {
  var index = -1,
      length = entries ? entries.length : 0;

  this.clear();
  while (++index < length) {
    var entry = entries[index];
    this.set(entry[0], entry[1]);
  }
}

/**
 * Removes all key-value entries from the list cache.
 *
 * @private
 * @name clear
 * @memberOf ListCache
 */
function listCacheClear() {
  this.__data__ = [];
}

/**
 * Removes `key` and its value from the list cache.
 *
 * @private
 * @name delete
 * @memberOf ListCache
 * @param {string} key The key of the value to remove.
 * @returns {boolean} Returns `true` if the entry was removed, else `false`.
 */
function listCacheDelete(key) {
  var data = this.__data__,
      index = assocIndexOf(data, key);

  if (index < 0) {
    return false;
  }
  var lastIndex = data.length - 1;
  if (index == lastIndex) {
    data.pop();
  } else {
    splice.call(data, index, 1);
  }
  return true;
}

/**
 * Gets the list cache value for `key`.
 *
 * @private
 * @name get
 * @memberOf ListCache
 * @param {string} key The key of the value to get.
 * @returns {*} Returns the entry value.
 */
function listCacheGet(key) {
  var data = this.__data__,
      index = assocIndexOf(data, key);

  return index < 0 ? undefined : data[index][1];
}

/**
 * Checks if a list cache value for `key` exists.
 *
 * @private
 * @name has
 * @memberOf ListCache
 * @param {string} key The key of the entry to check.
 * @returns {boolean} Returns `true` if an entry for `key` exists, else `false`.
 */
function listCacheHas(key) {
  return assocIndexOf(this.__data__, key) > -1;
}

/**
 * Sets the list cache `key` to `value`.
 *
 * @private
 * @name set
 * @memberOf ListCache
 * @param {string} key The key of the value to set.
 * @param {*} value The value to set.
 * @returns {Object} Returns the list cache instance.
 */
function listCacheSet(key, value) {
  var data = this.__data__,
      index = assocIndexOf(data, key);

  if (index < 0) {
    data.push([key, value]);
  } else {
    data[index][1] = value;
  }
  return this;
}

// Add methods to `ListCache`.
ListCache.prototype.clear = listCacheClear;
ListCache.prototype['delete'] = listCacheDelete;
ListCache.prototype.get = listCacheGet;
ListCache.prototype.has = listCacheHas;
ListCache.prototype.set = listCacheSet;

/**
 * Creates a map cache object to store key-value pairs.
 *
 * @private
 * @constructor
 * @param {Array} [entries] The key-value pairs to cache.
 */
function MapCache(entries) {
  var index = -1,
      length = entries ? entries.length : 0;

  this.clear();
  while (++index < length) {
    var entry = entries[index];
    this.set(entry[0], entry[1]);
  }
}

/**
 * Removes all key-value entries from the map.
 *
 * @private
 * @name clear
 * @memberOf MapCache
 */
function mapCacheClear() {
  this.__data__ = {
    'hash': new Hash,
    'map': new (Map || ListCache),
    'string': new Hash
  };
}

/**
 * Removes `key` and its value from the map.
 *
 * @private
 * @name delete
 * @memberOf MapCache
 * @param {string} key The key of the value to remove.
 * @returns {boolean} Returns `true` if the entry was removed, else `false`.
 */
function mapCacheDelete(key) {
  return getMapData(this, key)['delete'](key);
}

/**
 * Gets the map value for `key`.
 *
 * @private
 * @name get
 * @memberOf MapCache
 * @param {string} key The key of the value to get.
 * @returns {*} Returns the entry value.
 */
function mapCacheGet(key) {
  return getMapData(this, key).get(key);
}

/**
 * Checks if a map value for `key` exists.
 *
 * @private
 * @name has
 * @memberOf MapCache
 * @param {string} key The key of the entry to check.
 * @returns {boolean} Returns `true` if an entry for `key` exists, else `false`.
 */
function mapCacheHas(key) {
  return getMapData(this, key).has(key);
}

/**
 * Sets the map `key` to `value`.
 *
 * @private
 * @name set
 * @memberOf MapCache
 * @param {string} key The key of the value to set.
 * @param {*} value The value to set.
 * @returns {Object} Returns the map cache instance.
 */
function mapCacheSet(key, value) {
  getMapData(this, key).set(key, value);
  return this;
}

// Add methods to `MapCache`.
MapCache.prototype.clear = mapCacheClear;
MapCache.prototype['delete'] = mapCacheDelete;
MapCache.prototype.get = mapCacheGet;
MapCache.prototype.has = mapCacheHas;
MapCache.prototype.set = mapCacheSet;

/**
 * Gets the index at which the `key` is found in `array` of key-value pairs.
 *
 * @private
 * @param {Array} array The array to inspect.
 * @param {*} key The key to search for.
 * @returns {number} Returns the index of the matched value, else `-1`.
 */
function assocIndexOf(array, key) {
  var length = array.length;
  while (length--) {
    if (eq(array[length][0], key)) {
      return length;
    }
  }
  return -1;
}

/**
 * The base implementation of `_.get` without support for default values.
 *
 * @private
 * @param {Object} object The object to query.
 * @param {Array|string} path The path of the property to get.
 * @returns {*} Returns the resolved value.
 */
function baseGet(object, path) {
  path = isKey(path, object) ? [path] : castPath(path);

  var index = 0,
      length = path.length;

  while (object != null && index < length) {
    object = object[toKey(path[index++])];
  }
  return (index && index == length) ? object : undefined;
}

/**
 * The base implementation of `_.isNative` without bad shim checks.
 *
 * @private
 * @param {*} value The value to check.
 * @returns {boolean} Returns `true` if `value` is a native function,
 *  else `false`.
 */
function baseIsNative(value) {
  if (!isObject(value) || isMasked(value)) {
    return false;
  }
  var pattern = (isFunction(value) || isHostObject(value)) ? reIsNative : reIsHostCtor;
  return pattern.test(toSource(value));
}

/**
 * The base implementation of `_.toString` which doesn't convert nullish
 * values to empty strings.
 *
 * @private
 * @param {*} value The value to process.
 * @returns {string} Returns the string.
 */
function baseToString(value) {
  // Exit early for strings to avoid a performance hit in some environments.
  if (typeof value == 'string') {
    return value;
  }
  if (isSymbol(value)) {
    return symbolToString ? symbolToString.call(value) : '';
  }
  var result = (value + '');
  return (result == '0' && (1 / value) == -INFINITY) ? '-0' : result;
}

/**
 * Casts `value` to a path array if it's not one.
 *
 * @private
 * @param {*} value The value to inspect.
 * @returns {Array} Returns the cast property path array.
 */
function castPath(value) {
  return isArray(value) ? value : stringToPath(value);
}

/**
 * Gets the data for `map`.
 *
 * @private
 * @param {Object} map The map to query.
 * @param {string} key The reference key.
 * @returns {*} Returns the map data.
 */
function getMapData(map, key) {
  var data = map.__data__;
  return isKeyable(key)
    ? data[typeof key == 'string' ? 'string' : 'hash']
    : data.map;
}

/**
 * Gets the native function at `key` of `object`.
 *
 * @private
 * @param {Object} object The object to query.
 * @param {string} key The key of the method to get.
 * @returns {*} Returns the function if it's native, else `undefined`.
 */
function getNative(object, key) {
  var value = getValue(object, key);
  return baseIsNative(value) ? value : undefined;
}

/**
 * Checks if `value` is a property name and not a property path.
 *
 * @private
 * @param {*} value The value to check.
 * @param {Object} [object] The object to query keys on.
 * @returns {boolean} Returns `true` if `value` is a property name, else `false`.
 */
function isKey(value, object) {
  if (isArray(value)) {
    return false;
  }
  var type = typeof value;
  if (type == 'number' || type == 'symbol' || type == 'boolean' ||
      value == null || isSymbol(value)) {
    return true;
  }
  return reIsPlainProp.test(value) || !reIsDeepProp.test(value) ||
    (object != null && value in Object(object));
}

/**
 * Checks if `value` is suitable for use as unique object key.
 *
 * @private
 * @param {*} value The value to check.
 * @returns {boolean} Returns `true` if `value` is suitable, else `false`.
 */
function isKeyable(value) {
  var type = typeof value;
  return (type == 'string' || type == 'number' || type == 'symbol' || type == 'boolean')
    ? (value !== '__proto__')
    : (value === null);
}

/**
 * Checks if `func` has its source masked.
 *
 * @private
 * @param {Function} func The function to check.
 * @returns {boolean} Returns `true` if `func` is masked, else `false`.
 */
function isMasked(func) {
  return !!maskSrcKey && (maskSrcKey in func);
}

/**
 * Converts `string` to a property path array.
 *
 * @private
 * @param {string} string The string to convert.
 * @returns {Array} Returns the property path array.
 */
var stringToPath = memoize(function(string) {
  string = toString(string);

  var result = [];
  if (reLeadingDot.test(string)) {
    result.push('');
  }
  string.replace(rePropName, function(match, number, quote, string) {
    result.push(quote ? string.replace(reEscapeChar, '$1') : (number || match));
  });
  return result;
});

/**
 * Converts `value` to a string key if it's not a string or symbol.
 *
 * @private
 * @param {*} value The value to inspect.
 * @returns {string|symbol} Returns the key.
 */
function toKey(value) {
  if (typeof value == 'string' || isSymbol(value)) {
    return value;
  }
  var result = (value + '');
  return (result == '0' && (1 / value) == -INFINITY) ? '-0' : result;
}

/**
 * Converts `func` to its source code.
 *
 * @private
 * @param {Function} func The function to process.
 * @returns {string} Returns the source code.
 */
function toSource(func) {
  if (func != null) {
    try {
      return funcToString.call(func);
    } catch (e) {}
    try {
      return (func + '');
    } catch (e) {}
  }
  return '';
}

/**
 * Creates a function that memoizes the result of `func`. If `resolver` is
 * provided, it determines the cache key for storing the result based on the
 * arguments provided to the memoized function. By default, the first argument
 * provided to the memoized function is used as the map cache key. The `func`
 * is invoked with the `this` binding of the memoized function.
 *
 * **Note:** The cache is exposed as the `cache` property on the memoized
 * function. Its creation may be customized by replacing the `_.memoize.Cache`
 * constructor with one whose instances implement the
 * [`Map`](http://ecma-international.org/ecma-262/7.0/#sec-properties-of-the-map-prototype-object)
 * method interface of `delete`, `get`, `has`, and `set`.
 *
 * @static
 * @memberOf _
 * @since 0.1.0
 * @category Function
 * @param {Function} func The function to have its output memoized.
 * @param {Function} [resolver] The function to resolve the cache key.
 * @returns {Function} Returns the new memoized function.
 * @example
 *
 * var object = { 'a': 1, 'b': 2 };
 * var other = { 'c': 3, 'd': 4 };
 *
 * var values = _.memoize(_.values);
 * values(object);
 * // => [1, 2]
 *
 * values(other);
 * // => [3, 4]
 *
 * object.a = 2;
 * values(object);
 * // => [1, 2]
 *
 * // Modify the result cache.
 * values.cache.set(object, ['a', 'b']);
 * values(object);
 * // => ['a', 'b']
 *
 * // Replace `_.memoize.Cache`.
 * _.memoize.Cache = WeakMap;
 */
function memoize(func, resolver) {
  if (typeof func != 'function' || (resolver && typeof resolver != 'function')) {
    throw new TypeError(FUNC_ERROR_TEXT);
  }
  var memoized = function() {
    var args = arguments,
        key = resolver ? resolver.apply(this, args) : args[0],
        cache = memoized.cache;

    if (cache.has(key)) {
      return cache.get(key);
    }
    var result = func.apply(this, args);
    memoized.cache = cache.set(key, result);
    return result;
  };
  memoized.cache = new (memoize.Cache || MapCache);
  return memoized;
}

// Assign cache to `_.memoize`.
memoize.Cache = MapCache;

/**
 * Performs a
 * [`SameValueZero`](http://ecma-international.org/ecma-262/7.0/#sec-samevaluezero)
 * comparison between two values to determine if they are equivalent.
 *
 * @static
 * @memberOf _
 * @since 4.0.0
 * @category Lang
 * @param {*} value The value to compare.
 * @param {*} other The other value to compare.
 * @returns {boolean} Returns `true` if the values are equivalent, else `false`.
 * @example
 *
 * var object = { 'a': 1 };
 * var other = { 'a': 1 };
 *
 * _.eq(object, object);
 * // => true
 *
 * _.eq(object, other);
 * // => false
 *
 * _.eq('a', 'a');
 * // => true
 *
 * _.eq('a', Object('a'));
 * // => false
 *
 * _.eq(NaN, NaN);
 * // => true
 */
function eq(value, other) {
  return value === other || (value !== value && other !== other);
}

/**
 * Checks if `value` is classified as an `Array` object.
 *
 * @static
 * @memberOf _
 * @since 0.1.0
 * @category Lang
 * @param {*} value The value to check.
 * @returns {boolean} Returns `true` if `value` is an array, else `false`.
 * @example
 *
 * _.isArray([1, 2, 3]);
 * // => true
 *
 * _.isArray(document.body.children);
 * // => false
 *
 * _.isArray('abc');
 * // => false
 *
 * _.isArray(_.noop);
 * // => false
 */
var isArray = Array.isArray;

/**
 * Checks if `value` is classified as a `Function` object.
 *
 * @static
 * @memberOf _
 * @since 0.1.0
 * @category Lang
 * @param {*} value The value to check.
 * @returns {boolean} Returns `true` if `value` is a function, else `false`.
 * @example
 *
 * _.isFunction(_);
 * // => true
 *
 * _.isFunction(/abc/);
 * // => false
 */
function isFunction(value) {
  // The use of `Object#toString` avoids issues with the `typeof` operator
  // in Safari 8-9 which returns 'object' for typed array and other constructors.
  var tag = isObject(value) ? objectToString.call(value) : '';
  return tag == funcTag || tag == genTag;
}

/**
 * Checks if `value` is the
 * [language type](http://www.ecma-international.org/ecma-262/7.0/#sec-ecmascript-language-types)
 * of `Object`. (e.g. arrays, functions, objects, regexes, `new Number(0)`, and `new String('')`)
 *
 * @static
 * @memberOf _
 * @since 0.1.0
 * @category Lang
 * @param {*} value The value to check.
 * @returns {boolean} Returns `true` if `value` is an object, else `false`.
 * @example
 *
 * _.isObject({});
 * // => true
 *
 * _.isObject([1, 2, 3]);
 * // => true
 *
 * _.isObject(_.noop);
 * // => true
 *
 * _.isObject(null);
 * // => false
 */
function isObject(value) {
  var type = typeof value;
  return !!value && (type == 'object' || type == 'function');
}

/**
 * Checks if `value` is object-like. A value is object-like if it's not `null`
 * and has a `typeof` result of "object".
 *
 * @static
 * @memberOf _
 * @since 4.0.0
 * @category Lang
 * @param {*} value The value to check.
 * @returns {boolean} Returns `true` if `value` is object-like, else `false`.
 * @example
 *
 * _.isObjectLike({});
 * // => true
 *
 * _.isObjectLike([1, 2, 3]);
 * // => true
 *
 * _.isObjectLike(_.noop);
 * // => false
 *
 * _.isObjectLike(null);
 * // => false
 */
function isObjectLike(value) {
  return !!value && typeof value == 'object';
}

/**
 * Checks if `value` is classified as a `Symbol` primitive or object.
 *
 * @static
 * @memberOf _
 * @since 4.0.0
 * @category Lang
 * @param {*} value The value to check.
 * @returns {boolean} Returns `true` if `value` is a symbol, else `false`.
 * @example
 *
 * _.isSymbol(Symbol.iterator);
 * // => true
 *
 * _.isSymbol('abc');
 * // => false
 */
function isSymbol(value) {
  return typeof value == 'symbol' ||
    (isObjectLike(value) && objectToString.call(value) == symbolTag);
}

/**
 * Converts `value` to a string. An empty string is returned for `null`
 * and `undefined` values. The sign of `-0` is preserved.
 *
 * @static
 * @memberOf _
 * @since 4.0.0
 * @category Lang
 * @param {*} value The value to process.
 * @returns {string} Returns the string.
 * @example
 *
 * _.toString(null);
 * // => ''
 *
 * _.toString(-0);
 * // => '-0'
 *
 * _.toString([1, 2, 3]);
 * // => '1,2,3'
 */
function toString(value) {
  return value == null ? '' : baseToString(value);
}

/**
 * Gets the value at `path` of `object`. If the resolved value is
 * `undefined`, the `defaultValue` is returned in its place.
 *
 * @static
 * @memberOf _
 * @since 3.7.0
 * @category Object
 * @param {Object} object The object to query.
 * @param {Array|string} path The path of the property to get.
 * @param {*} [defaultValue] The value returned for `undefined` resolved values.
 * @returns {*} Returns the resolved value.
 * @example
 *
 * var object = { 'a': [{ 'b': { 'c': 3 } }] };
 *
 * _.get(object, 'a[0].b.c');
 * // => 3
 *
 * _.get(object, ['a', '0', 'b', 'c']);
 * // => 3
 *
 * _.get(object, 'a.b.c', 'default');
 * // => 'default'
 */
function get(object, path, defaultValue) {
  var result = object == null ? undefined : baseGet(object, path);
  return result === undefined ? defaultValue : result;
}

module.exports = get;

});
$_mod.def("/@ebay/retriever$1.0.0/index", function(require, exports, module, __filename, __dirname) { 'use strict';

var _get = require('/lodash.get$4.4.2/index'/*'lodash.get'*/);

var logger;
var isArray = Array.isArray;
var EVENT_TYPES = {
    DATA_MISSING: 'dataMissing',
    TYPE_MISMATCH: 'typeMismatch'
};

/**
 * Determine if an object is empty
 * Copied from lodash.isEmpty, but optimized to only handle objects
 * @param obj - object to check
 */
function isEmpty(obj) {
    for (var key in obj) {
        if (hasOwnProperty.call(obj, key)) {
            return false;
        }
    }
    return true;
}

/**
 * Get `typeof`, but with stricter checking for array and null
 * @param val - value of which to check type
 */
function getType(val) {
    var type;

    if (isArray(val)) {
        type = 'array';
    } else if (val === null) {
        type = 'null';
    } else {
        type = typeof val;
    }

    return type;
}

/**
 * Log event
 * @param path - a string representation of the lookup
 * @param eventType - event type from EVENT_TYPES enum
 * @param defaultValue - default when data is absent, also used to check type
 * @param logType - logger method to use
 */
function log(eventType, path, defaultValue, logType) {
    if (logger[logType]) {
        logger[logType]('event: %s, path: %s, default: %s', eventType, path, defaultValue);
    }
}

/**
 * Attempt to get object path, otherwise use defaultValue
 * @param object - the object where we are extracting data
 * @param path - a string representation of the lookup
 * @param defaultValue - default when data is absent, also used to check type
 * @param logType - logger method to use
 */
function access(object, path, defaultValue, logType) {
    var eventType;
    var result = _get(object, path);
    var typeofResult = getType(result);
    var typeofDefaultValue = getType(defaultValue);

    if (typeofDefaultValue === 'undefined') {
        defaultValue = '';
        typeofDefaultValue = 'string';
    } else if (typeofDefaultValue === 'object' && isEmpty(defaultValue)) {
        defaultValue = {__isEmpty: true};
    }

    if (typeofResult !== 'undefined') {
        if (typeofResult !== typeofDefaultValue) {
            eventType = EVENT_TYPES.TYPE_MISMATCH;
            result = defaultValue;
        }
    } else {
        eventType = EVENT_TYPES.DATA_MISSING;
        result = defaultValue;
    }

    if (logger && eventType) {
        log(eventType, path, defaultValue, logType);
    }

    return result;
}

function need(object, path, defaultValue) {
    return access(object, path, defaultValue, 'warn');
}

function get(object, path, defaultValue) {
    return access(object, path, defaultValue, 'debug');
}

/**
 * Return whether given object has path with value that is not null or undefined
 * @param object - the object where we are extracting data
 * @param path - a string representation of the lookup
 */
function has(object, path) {
    var result = _get(object, path);
    var typeofResult = getType(result);

    result = !(typeofResult === 'undefined' || typeofResult === 'null');

    if (logger && !result) {
        log(EVENT_TYPES.DATA_MISSING, path, false, 'debug');
    }

    return result;
}

/**
 * Set logger to be used for all future usage
 * @param object l - the logger with debug and warn functions
 */
function setLogger(l) {
    logger = l;
}

module.exports = {
    need: need,
    get: get,
    has: has,
    setLogger: setLogger
};

module.exports.privates = {
    EVENT_TYPES: EVENT_TYPES
};

});
$_mod.def("/myebaynode$1.0.0/src/fe-components/m-lazy/index.marko", function(require, exports, module, __filename, __dirname) { // Compiled using marko@4.4.28 - DO NOT EDIT
"use strict";

var marko_template = module.exports = require('/marko$4.4.28/src/vdom'/*"marko/src/vdom"*/).t(),
    marko_helpers = require('/marko$4.4.28/src/runtime/vdom/helpers'/*"marko/src/runtime/vdom/helpers"*/),
    marko_loadTag = marko_helpers.t,
    lasso_slot_tag = marko_loadTag(require('/lasso$2.11.24/taglib/noop-render'/*"lasso/taglib/slot-tag"*/));

function render(input, out) {
  var data = input;

  const get = require('/@ebay/retriever$1.0.0/index'/*'@ebay/retriever'*/).get;

  const nearbyBuffer = get(out, 'global.req.settings.lazy.nearbyBuffer', -1);

  lasso_slot_tag({
      name: "inline-js-lazy-load"
    }, out);

  out.e("SCRIPT", null, 3)
    .t("\n    window.MYEBAY && window.MYEBAY.lazy && window.MYEBAY.lazy.initialize(")
    .t(nearbyBuffer)
    .t(");\n");
}

marko_template._ = render;

});
$_mod.remap("/lasso$2.11.24/taglib/body-tag", "/lasso$2.11.24/taglib/noop-render");
$_mod.installed("myebaynode$1.0.0", "browser-refresh-taglib", "1.1.0");
$_mod.builtin("process", "/process$0.6.0/browser");
$_mod.def("/process$0.6.0/browser", function(require, exports, module, __filename, __dirname) { // shim for using process in browser

var process = module.exports = {};

process.nextTick = (function () {
    var canSetImmediate = typeof window !== 'undefined'
    && window.setImmediate;
    var canPost = typeof window !== 'undefined'
    && window.postMessage && window.addEventListener
    ;

    if (canSetImmediate) {
        return function (f) { return window.setImmediate(f) };
    }

    if (canPost) {
        var queue = [];
        window.addEventListener('message', function (ev) {
            var source = ev.source;
            if ((source === window || source === null) && ev.data === 'process-tick') {
                ev.stopPropagation();
                if (queue.length > 0) {
                    var fn = queue.shift();
                    fn();
                }
            }
        }, true);

        return function nextTick(fn) {
            queue.push(fn);
            window.postMessage('process-tick', '*');
        };
    }

    return function nextTick(fn) {
        setTimeout(fn, 0);
    };
})();

process.title = 'browser';
process.browser = true;
process.env = {};
process.argv = [];

function noop() {}

process.on = noop;
process.once = noop;
process.off = noop;
process.emit = noop;

process.binding = function (name) {
    throw new Error('process.binding is not supported');
}

// TODO(shtylman)
process.cwd = function () { return '/' };
process.chdir = function (dir) {
    throw new Error('process.chdir is not supported');
};

});
$_mod.builtin("url", "/url$0.11.0/url");
$_mod.installed("url$0.11.0", "punycode", "1.3.2");
$_mod.main("/punycode$1.3.2", "punycode");
$_mod.def("/punycode$1.3.2/punycode", function(require, exports, module, __filename, __dirname) { /*! https://mths.be/punycode v1.3.2 by @mathias */
;(function(root) {

	/** Detect free variables */
	var freeExports = typeof exports == 'object' && exports &&
		!exports.nodeType && exports;
	var freeModule = typeof module == 'object' && module &&
		!module.nodeType && module;
	var freeGlobal = typeof global == 'object' && global;
	if (
		freeGlobal.global === freeGlobal ||
		freeGlobal.window === freeGlobal ||
		freeGlobal.self === freeGlobal
	) {
		root = freeGlobal;
	}

	/**
	 * The `punycode` object.
	 * @name punycode
	 * @type Object
	 */
	var punycode,

	/** Highest positive signed 32-bit float value */
	maxInt = 2147483647, // aka. 0x7FFFFFFF or 2^31-1

	/** Bootstring parameters */
	base = 36,
	tMin = 1,
	tMax = 26,
	skew = 38,
	damp = 700,
	initialBias = 72,
	initialN = 128, // 0x80
	delimiter = '-', // '\x2D'

	/** Regular expressions */
	regexPunycode = /^xn--/,
	regexNonASCII = /[^\x20-\x7E]/, // unprintable ASCII chars + non-ASCII chars
	regexSeparators = /[\x2E\u3002\uFF0E\uFF61]/g, // RFC 3490 separators

	/** Error messages */
	errors = {
		'overflow': 'Overflow: input needs wider integers to process',
		'not-basic': 'Illegal input >= 0x80 (not a basic code point)',
		'invalid-input': 'Invalid input'
	},

	/** Convenience shortcuts */
	baseMinusTMin = base - tMin,
	floor = Math.floor,
	stringFromCharCode = String.fromCharCode,

	/** Temporary variable */
	key;

	/*--------------------------------------------------------------------------*/

	/**
	 * A generic error utility function.
	 * @private
	 * @param {String} type The error type.
	 * @returns {Error} Throws a `RangeError` with the applicable error message.
	 */
	function error(type) {
		throw RangeError(errors[type]);
	}

	/**
	 * A generic `Array#map` utility function.
	 * @private
	 * @param {Array} array The array to iterate over.
	 * @param {Function} callback The function that gets called for every array
	 * item.
	 * @returns {Array} A new array of values returned by the callback function.
	 */
	function map(array, fn) {
		var length = array.length;
		var result = [];
		while (length--) {
			result[length] = fn(array[length]);
		}
		return result;
	}

	/**
	 * A simple `Array#map`-like wrapper to work with domain name strings or email
	 * addresses.
	 * @private
	 * @param {String} domain The domain name or email address.
	 * @param {Function} callback The function that gets called for every
	 * character.
	 * @returns {Array} A new string of characters returned by the callback
	 * function.
	 */
	function mapDomain(string, fn) {
		var parts = string.split('@');
		var result = '';
		if (parts.length > 1) {
			// In email addresses, only the domain name should be punycoded. Leave
			// the local part (i.e. everything up to `@`) intact.
			result = parts[0] + '@';
			string = parts[1];
		}
		// Avoid `split(regex)` for IE8 compatibility. See #17.
		string = string.replace(regexSeparators, '\x2E');
		var labels = string.split('.');
		var encoded = map(labels, fn).join('.');
		return result + encoded;
	}

	/**
	 * Creates an array containing the numeric code points of each Unicode
	 * character in the string. While JavaScript uses UCS-2 internally,
	 * this function will convert a pair of surrogate halves (each of which
	 * UCS-2 exposes as separate characters) into a single code point,
	 * matching UTF-16.
	 * @see `punycode.ucs2.encode`
	 * @see <https://mathiasbynens.be/notes/javascript-encoding>
	 * @memberOf punycode.ucs2
	 * @name decode
	 * @param {String} string The Unicode input string (UCS-2).
	 * @returns {Array} The new array of code points.
	 */
	function ucs2decode(string) {
		var output = [],
		    counter = 0,
		    length = string.length,
		    value,
		    extra;
		while (counter < length) {
			value = string.charCodeAt(counter++);
			if (value >= 0xD800 && value <= 0xDBFF && counter < length) {
				// high surrogate, and there is a next character
				extra = string.charCodeAt(counter++);
				if ((extra & 0xFC00) == 0xDC00) { // low surrogate
					output.push(((value & 0x3FF) << 10) + (extra & 0x3FF) + 0x10000);
				} else {
					// unmatched surrogate; only append this code unit, in case the next
					// code unit is the high surrogate of a surrogate pair
					output.push(value);
					counter--;
				}
			} else {
				output.push(value);
			}
		}
		return output;
	}

	/**
	 * Creates a string based on an array of numeric code points.
	 * @see `punycode.ucs2.decode`
	 * @memberOf punycode.ucs2
	 * @name encode
	 * @param {Array} codePoints The array of numeric code points.
	 * @returns {String} The new Unicode string (UCS-2).
	 */
	function ucs2encode(array) {
		return map(array, function(value) {
			var output = '';
			if (value > 0xFFFF) {
				value -= 0x10000;
				output += stringFromCharCode(value >>> 10 & 0x3FF | 0xD800);
				value = 0xDC00 | value & 0x3FF;
			}
			output += stringFromCharCode(value);
			return output;
		}).join('');
	}

	/**
	 * Converts a basic code point into a digit/integer.
	 * @see `digitToBasic()`
	 * @private
	 * @param {Number} codePoint The basic numeric code point value.
	 * @returns {Number} The numeric value of a basic code point (for use in
	 * representing integers) in the range `0` to `base - 1`, or `base` if
	 * the code point does not represent a value.
	 */
	function basicToDigit(codePoint) {
		if (codePoint - 48 < 10) {
			return codePoint - 22;
		}
		if (codePoint - 65 < 26) {
			return codePoint - 65;
		}
		if (codePoint - 97 < 26) {
			return codePoint - 97;
		}
		return base;
	}

	/**
	 * Converts a digit/integer into a basic code point.
	 * @see `basicToDigit()`
	 * @private
	 * @param {Number} digit The numeric value of a basic code point.
	 * @returns {Number} The basic code point whose value (when used for
	 * representing integers) is `digit`, which needs to be in the range
	 * `0` to `base - 1`. If `flag` is non-zero, the uppercase form is
	 * used; else, the lowercase form is used. The behavior is undefined
	 * if `flag` is non-zero and `digit` has no uppercase form.
	 */
	function digitToBasic(digit, flag) {
		//  0..25 map to ASCII a..z or A..Z
		// 26..35 map to ASCII 0..9
		return digit + 22 + 75 * (digit < 26) - ((flag != 0) << 5);
	}

	/**
	 * Bias adaptation function as per section 3.4 of RFC 3492.
	 * http://tools.ietf.org/html/rfc3492#section-3.4
	 * @private
	 */
	function adapt(delta, numPoints, firstTime) {
		var k = 0;
		delta = firstTime ? floor(delta / damp) : delta >> 1;
		delta += floor(delta / numPoints);
		for (/* no initialization */; delta > baseMinusTMin * tMax >> 1; k += base) {
			delta = floor(delta / baseMinusTMin);
		}
		return floor(k + (baseMinusTMin + 1) * delta / (delta + skew));
	}

	/**
	 * Converts a Punycode string of ASCII-only symbols to a string of Unicode
	 * symbols.
	 * @memberOf punycode
	 * @param {String} input The Punycode string of ASCII-only symbols.
	 * @returns {String} The resulting string of Unicode symbols.
	 */
	function decode(input) {
		// Don't use UCS-2
		var output = [],
		    inputLength = input.length,
		    out,
		    i = 0,
		    n = initialN,
		    bias = initialBias,
		    basic,
		    j,
		    index,
		    oldi,
		    w,
		    k,
		    digit,
		    t,
		    /** Cached calculation results */
		    baseMinusT;

		// Handle the basic code points: let `basic` be the number of input code
		// points before the last delimiter, or `0` if there is none, then copy
		// the first basic code points to the output.

		basic = input.lastIndexOf(delimiter);
		if (basic < 0) {
			basic = 0;
		}

		for (j = 0; j < basic; ++j) {
			// if it's not a basic code point
			if (input.charCodeAt(j) >= 0x80) {
				error('not-basic');
			}
			output.push(input.charCodeAt(j));
		}

		// Main decoding loop: start just after the last delimiter if any basic code
		// points were copied; start at the beginning otherwise.

		for (index = basic > 0 ? basic + 1 : 0; index < inputLength; /* no final expression */) {

			// `index` is the index of the next character to be consumed.
			// Decode a generalized variable-length integer into `delta`,
			// which gets added to `i`. The overflow checking is easier
			// if we increase `i` as we go, then subtract off its starting
			// value at the end to obtain `delta`.
			for (oldi = i, w = 1, k = base; /* no condition */; k += base) {

				if (index >= inputLength) {
					error('invalid-input');
				}

				digit = basicToDigit(input.charCodeAt(index++));

				if (digit >= base || digit > floor((maxInt - i) / w)) {
					error('overflow');
				}

				i += digit * w;
				t = k <= bias ? tMin : (k >= bias + tMax ? tMax : k - bias);

				if (digit < t) {
					break;
				}

				baseMinusT = base - t;
				if (w > floor(maxInt / baseMinusT)) {
					error('overflow');
				}

				w *= baseMinusT;

			}

			out = output.length + 1;
			bias = adapt(i - oldi, out, oldi == 0);

			// `i` was supposed to wrap around from `out` to `0`,
			// incrementing `n` each time, so we'll fix that now:
			if (floor(i / out) > maxInt - n) {
				error('overflow');
			}

			n += floor(i / out);
			i %= out;

			// Insert `n` at position `i` of the output
			output.splice(i++, 0, n);

		}

		return ucs2encode(output);
	}

	/**
	 * Converts a string of Unicode symbols (e.g. a domain name label) to a
	 * Punycode string of ASCII-only symbols.
	 * @memberOf punycode
	 * @param {String} input The string of Unicode symbols.
	 * @returns {String} The resulting Punycode string of ASCII-only symbols.
	 */
	function encode(input) {
		var n,
		    delta,
		    handledCPCount,
		    basicLength,
		    bias,
		    j,
		    m,
		    q,
		    k,
		    t,
		    currentValue,
		    output = [],
		    /** `inputLength` will hold the number of code points in `input`. */
		    inputLength,
		    /** Cached calculation results */
		    handledCPCountPlusOne,
		    baseMinusT,
		    qMinusT;

		// Convert the input in UCS-2 to Unicode
		input = ucs2decode(input);

		// Cache the length
		inputLength = input.length;

		// Initialize the state
		n = initialN;
		delta = 0;
		bias = initialBias;

		// Handle the basic code points
		for (j = 0; j < inputLength; ++j) {
			currentValue = input[j];
			if (currentValue < 0x80) {
				output.push(stringFromCharCode(currentValue));
			}
		}

		handledCPCount = basicLength = output.length;

		// `handledCPCount` is the number of code points that have been handled;
		// `basicLength` is the number of basic code points.

		// Finish the basic string - if it is not empty - with a delimiter
		if (basicLength) {
			output.push(delimiter);
		}

		// Main encoding loop:
		while (handledCPCount < inputLength) {

			// All non-basic code points < n have been handled already. Find the next
			// larger one:
			for (m = maxInt, j = 0; j < inputLength; ++j) {
				currentValue = input[j];
				if (currentValue >= n && currentValue < m) {
					m = currentValue;
				}
			}

			// Increase `delta` enough to advance the decoder's <n,i> state to <m,0>,
			// but guard against overflow
			handledCPCountPlusOne = handledCPCount + 1;
			if (m - n > floor((maxInt - delta) / handledCPCountPlusOne)) {
				error('overflow');
			}

			delta += (m - n) * handledCPCountPlusOne;
			n = m;

			for (j = 0; j < inputLength; ++j) {
				currentValue = input[j];

				if (currentValue < n && ++delta > maxInt) {
					error('overflow');
				}

				if (currentValue == n) {
					// Represent delta as a generalized variable-length integer
					for (q = delta, k = base; /* no condition */; k += base) {
						t = k <= bias ? tMin : (k >= bias + tMax ? tMax : k - bias);
						if (q < t) {
							break;
						}
						qMinusT = q - t;
						baseMinusT = base - t;
						output.push(
							stringFromCharCode(digitToBasic(t + qMinusT % baseMinusT, 0))
						);
						q = floor(qMinusT / baseMinusT);
					}

					output.push(stringFromCharCode(digitToBasic(q, 0)));
					bias = adapt(delta, handledCPCountPlusOne, handledCPCount == basicLength);
					delta = 0;
					++handledCPCount;
				}
			}

			++delta;
			++n;

		}
		return output.join('');
	}

	/**
	 * Converts a Punycode string representing a domain name or an email address
	 * to Unicode. Only the Punycoded parts of the input will be converted, i.e.
	 * it doesn't matter if you call it on a string that has already been
	 * converted to Unicode.
	 * @memberOf punycode
	 * @param {String} input The Punycoded domain name or email address to
	 * convert to Unicode.
	 * @returns {String} The Unicode representation of the given Punycode
	 * string.
	 */
	function toUnicode(input) {
		return mapDomain(input, function(string) {
			return regexPunycode.test(string)
				? decode(string.slice(4).toLowerCase())
				: string;
		});
	}

	/**
	 * Converts a Unicode string representing a domain name or an email address to
	 * Punycode. Only the non-ASCII parts of the domain name will be converted,
	 * i.e. it doesn't matter if you call it with a domain that's already in
	 * ASCII.
	 * @memberOf punycode
	 * @param {String} input The domain name or email address to convert, as a
	 * Unicode string.
	 * @returns {String} The Punycode representation of the given domain name or
	 * email address.
	 */
	function toASCII(input) {
		return mapDomain(input, function(string) {
			return regexNonASCII.test(string)
				? 'xn--' + encode(string)
				: string;
		});
	}

	/*--------------------------------------------------------------------------*/

	/** Define the public API */
	punycode = {
		/**
		 * A string representing the current Punycode.js version number.
		 * @memberOf punycode
		 * @type String
		 */
		'version': '1.3.2',
		/**
		 * An object of methods to convert from JavaScript's internal character
		 * representation (UCS-2) to Unicode code points, and back.
		 * @see <https://mathiasbynens.be/notes/javascript-encoding>
		 * @memberOf punycode
		 * @type Object
		 */
		'ucs2': {
			'decode': ucs2decode,
			'encode': ucs2encode
		},
		'decode': decode,
		'encode': encode,
		'toASCII': toASCII,
		'toUnicode': toUnicode
	};

	/** Expose `punycode` */
	// Some AMD build optimizers, like r.js, check for specific condition patterns
	// like the following:
	if (
		typeof define == 'function' &&
		typeof define.amd == 'object' &&
		define.amd
	) {
		define('punycode', function() {
			return punycode;
		});
	} else if (freeExports && freeModule) {
		if (module.exports == freeExports) { // in Node.js or RingoJS v0.8.0+
			freeModule.exports = punycode;
		} else { // in Narwhal or RingoJS v0.7.0-
			for (key in punycode) {
				punycode.hasOwnProperty(key) && (freeExports[key] = punycode[key]);
			}
		}
	} else { // in Rhino or a web browser
		root.punycode = punycode;
	}

}(this));

});
$_mod.def("/url$0.11.0/util", function(require, exports, module, __filename, __dirname) { 'use strict';

module.exports = {
  isString: function(arg) {
    return typeof(arg) === 'string';
  },
  isObject: function(arg) {
    return typeof(arg) === 'object' && arg !== null;
  },
  isNull: function(arg) {
    return arg === null;
  },
  isNullOrUndefined: function(arg) {
    return arg == null;
  }
};

});
$_mod.installed("url$0.11.0", "querystring", "0.2.0");
$_mod.main("/querystring$0.2.0", "");
$_mod.def("/querystring$0.2.0/decode", function(require, exports, module, __filename, __dirname) { // Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

'use strict';

// If obj.hasOwnProperty has been overridden, then calling
// obj.hasOwnProperty(prop) will break.
// See: https://github.com/joyent/node/issues/1707
function hasOwnProperty(obj, prop) {
  return Object.prototype.hasOwnProperty.call(obj, prop);
}

module.exports = function(qs, sep, eq, options) {
  sep = sep || '&';
  eq = eq || '=';
  var obj = {};

  if (typeof qs !== 'string' || qs.length === 0) {
    return obj;
  }

  var regexp = /\+/g;
  qs = qs.split(sep);

  var maxKeys = 1000;
  if (options && typeof options.maxKeys === 'number') {
    maxKeys = options.maxKeys;
  }

  var len = qs.length;
  // maxKeys <= 0 means that we should not limit keys count
  if (maxKeys > 0 && len > maxKeys) {
    len = maxKeys;
  }

  for (var i = 0; i < len; ++i) {
    var x = qs[i].replace(regexp, '%20'),
        idx = x.indexOf(eq),
        kstr, vstr, k, v;

    if (idx >= 0) {
      kstr = x.substr(0, idx);
      vstr = x.substr(idx + 1);
    } else {
      kstr = x;
      vstr = '';
    }

    k = decodeURIComponent(kstr);
    v = decodeURIComponent(vstr);

    if (!hasOwnProperty(obj, k)) {
      obj[k] = v;
    } else if (Array.isArray(obj[k])) {
      obj[k].push(v);
    } else {
      obj[k] = [obj[k], v];
    }
  }

  return obj;
};

});
$_mod.def("/querystring$0.2.0/encode", function(require, exports, module, __filename, __dirname) { // Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

'use strict';

var stringifyPrimitive = function(v) {
  switch (typeof v) {
    case 'string':
      return v;

    case 'boolean':
      return v ? 'true' : 'false';

    case 'number':
      return isFinite(v) ? v : '';

    default:
      return '';
  }
};

module.exports = function(obj, sep, eq, name) {
  sep = sep || '&';
  eq = eq || '=';
  if (obj === null) {
    obj = undefined;
  }

  if (typeof obj === 'object') {
    return Object.keys(obj).map(function(k) {
      var ks = encodeURIComponent(stringifyPrimitive(k)) + eq;
      if (Array.isArray(obj[k])) {
        return obj[k].map(function(v) {
          return ks + encodeURIComponent(stringifyPrimitive(v));
        }).join(sep);
      } else {
        return ks + encodeURIComponent(stringifyPrimitive(obj[k]));
      }
    }).join(sep);

  }

  if (!name) return '';
  return encodeURIComponent(stringifyPrimitive(name)) + eq +
         encodeURIComponent(stringifyPrimitive(obj));
};

});
$_mod.def("/querystring$0.2.0/index", function(require, exports, module, __filename, __dirname) { 'use strict';

exports.decode = exports.parse = require('/querystring$0.2.0/decode'/*'./decode'*/);
exports.encode = exports.stringify = require('/querystring$0.2.0/encode'/*'./encode'*/);

});
$_mod.def("/url$0.11.0/url", function(require, exports, module, __filename, __dirname) { // Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

'use strict';

var punycode = require('/punycode$1.3.2/punycode'/*'punycode'*/);
var util = require('/url$0.11.0/util'/*'./util'*/);

exports.parse = urlParse;
exports.resolve = urlResolve;
exports.resolveObject = urlResolveObject;
exports.format = urlFormat;

exports.Url = Url;

function Url() {
  this.protocol = null;
  this.slashes = null;
  this.auth = null;
  this.host = null;
  this.port = null;
  this.hostname = null;
  this.hash = null;
  this.search = null;
  this.query = null;
  this.pathname = null;
  this.path = null;
  this.href = null;
}

// Reference: RFC 3986, RFC 1808, RFC 2396

// define these here so at least they only have to be
// compiled once on the first module load.
var protocolPattern = /^([a-z0-9.+-]+:)/i,
    portPattern = /:[0-9]*$/,

    // Special case for a simple path URL
    simplePathPattern = /^(\/\/?(?!\/)[^\?\s]*)(\?[^\s]*)?$/,

    // RFC 2396: characters reserved for delimiting URLs.
    // We actually just auto-escape these.
    delims = ['<', '>', '"', '`', ' ', '\r', '\n', '\t'],

    // RFC 2396: characters not allowed for various reasons.
    unwise = ['{', '}', '|', '\\', '^', '`'].concat(delims),

    // Allowed by RFCs, but cause of XSS attacks.  Always escape these.
    autoEscape = ['\''].concat(unwise),
    // Characters that are never ever allowed in a hostname.
    // Note that any invalid chars are also handled, but these
    // are the ones that are *expected* to be seen, so we fast-path
    // them.
    nonHostChars = ['%', '/', '?', ';', '#'].concat(autoEscape),
    hostEndingChars = ['/', '?', '#'],
    hostnameMaxLen = 255,
    hostnamePartPattern = /^[+a-z0-9A-Z_-]{0,63}$/,
    hostnamePartStart = /^([+a-z0-9A-Z_-]{0,63})(.*)$/,
    // protocols that can allow "unsafe" and "unwise" chars.
    unsafeProtocol = {
      'javascript': true,
      'javascript:': true
    },
    // protocols that never have a hostname.
    hostlessProtocol = {
      'javascript': true,
      'javascript:': true
    },
    // protocols that always contain a // bit.
    slashedProtocol = {
      'http': true,
      'https': true,
      'ftp': true,
      'gopher': true,
      'file': true,
      'http:': true,
      'https:': true,
      'ftp:': true,
      'gopher:': true,
      'file:': true
    },
    querystring = require('/querystring$0.2.0/index'/*'querystring'*/);

function urlParse(url, parseQueryString, slashesDenoteHost) {
  if (url && util.isObject(url) && url instanceof Url) return url;

  var u = new Url;
  u.parse(url, parseQueryString, slashesDenoteHost);
  return u;
}

Url.prototype.parse = function(url, parseQueryString, slashesDenoteHost) {
  if (!util.isString(url)) {
    throw new TypeError("Parameter 'url' must be a string, not " + typeof url);
  }

  // Copy chrome, IE, opera backslash-handling behavior.
  // Back slashes before the query string get converted to forward slashes
  // See: https://code.google.com/p/chromium/issues/detail?id=25916
  var queryIndex = url.indexOf('?'),
      splitter =
          (queryIndex !== -1 && queryIndex < url.indexOf('#')) ? '?' : '#',
      uSplit = url.split(splitter),
      slashRegex = /\\/g;
  uSplit[0] = uSplit[0].replace(slashRegex, '/');
  url = uSplit.join(splitter);

  var rest = url;

  // trim before proceeding.
  // This is to support parse stuff like "  http://foo.com  \n"
  rest = rest.trim();

  if (!slashesDenoteHost && url.split('#').length === 1) {
    // Try fast path regexp
    var simplePath = simplePathPattern.exec(rest);
    if (simplePath) {
      this.path = rest;
      this.href = rest;
      this.pathname = simplePath[1];
      if (simplePath[2]) {
        this.search = simplePath[2];
        if (parseQueryString) {
          this.query = querystring.parse(this.search.substr(1));
        } else {
          this.query = this.search.substr(1);
        }
      } else if (parseQueryString) {
        this.search = '';
        this.query = {};
      }
      return this;
    }
  }

  var proto = protocolPattern.exec(rest);
  if (proto) {
    proto = proto[0];
    var lowerProto = proto.toLowerCase();
    this.protocol = lowerProto;
    rest = rest.substr(proto.length);
  }

  // figure out if it's got a host
  // user@server is *always* interpreted as a hostname, and url
  // resolution will treat //foo/bar as host=foo,path=bar because that's
  // how the browser resolves relative URLs.
  if (slashesDenoteHost || proto || rest.match(/^\/\/[^@\/]+@[^@\/]+/)) {
    var slashes = rest.substr(0, 2) === '//';
    if (slashes && !(proto && hostlessProtocol[proto])) {
      rest = rest.substr(2);
      this.slashes = true;
    }
  }

  if (!hostlessProtocol[proto] &&
      (slashes || (proto && !slashedProtocol[proto]))) {

    // there's a hostname.
    // the first instance of /, ?, ;, or # ends the host.
    //
    // If there is an @ in the hostname, then non-host chars *are* allowed
    // to the left of the last @ sign, unless some host-ending character
    // comes *before* the @-sign.
    // URLs are obnoxious.
    //
    // ex:
    // http://a@b@c/ => user:a@b host:c
    // http://a@b?@c => user:a host:c path:/?@c

    // v0.12 TODO(isaacs): This is not quite how Chrome does things.
    // Review our test case against browsers more comprehensively.

    // find the first instance of any hostEndingChars
    var hostEnd = -1;
    for (var i = 0; i < hostEndingChars.length; i++) {
      var hec = rest.indexOf(hostEndingChars[i]);
      if (hec !== -1 && (hostEnd === -1 || hec < hostEnd))
        hostEnd = hec;
    }

    // at this point, either we have an explicit point where the
    // auth portion cannot go past, or the last @ char is the decider.
    var auth, atSign;
    if (hostEnd === -1) {
      // atSign can be anywhere.
      atSign = rest.lastIndexOf('@');
    } else {
      // atSign must be in auth portion.
      // http://a@b/c@d => host:b auth:a path:/c@d
      atSign = rest.lastIndexOf('@', hostEnd);
    }

    // Now we have a portion which is definitely the auth.
    // Pull that off.
    if (atSign !== -1) {
      auth = rest.slice(0, atSign);
      rest = rest.slice(atSign + 1);
      this.auth = decodeURIComponent(auth);
    }

    // the host is the remaining to the left of the first non-host char
    hostEnd = -1;
    for (var i = 0; i < nonHostChars.length; i++) {
      var hec = rest.indexOf(nonHostChars[i]);
      if (hec !== -1 && (hostEnd === -1 || hec < hostEnd))
        hostEnd = hec;
    }
    // if we still have not hit it, then the entire thing is a host.
    if (hostEnd === -1)
      hostEnd = rest.length;

    this.host = rest.slice(0, hostEnd);
    rest = rest.slice(hostEnd);

    // pull out port.
    this.parseHost();

    // we've indicated that there is a hostname,
    // so even if it's empty, it has to be present.
    this.hostname = this.hostname || '';

    // if hostname begins with [ and ends with ]
    // assume that it's an IPv6 address.
    var ipv6Hostname = this.hostname[0] === '[' &&
        this.hostname[this.hostname.length - 1] === ']';

    // validate a little.
    if (!ipv6Hostname) {
      var hostparts = this.hostname.split(/\./);
      for (var i = 0, l = hostparts.length; i < l; i++) {
        var part = hostparts[i];
        if (!part) continue;
        if (!part.match(hostnamePartPattern)) {
          var newpart = '';
          for (var j = 0, k = part.length; j < k; j++) {
            if (part.charCodeAt(j) > 127) {
              // we replace non-ASCII char with a temporary placeholder
              // we need this to make sure size of hostname is not
              // broken by replacing non-ASCII by nothing
              newpart += 'x';
            } else {
              newpart += part[j];
            }
          }
          // we test again with ASCII char only
          if (!newpart.match(hostnamePartPattern)) {
            var validParts = hostparts.slice(0, i);
            var notHost = hostparts.slice(i + 1);
            var bit = part.match(hostnamePartStart);
            if (bit) {
              validParts.push(bit[1]);
              notHost.unshift(bit[2]);
            }
            if (notHost.length) {
              rest = '/' + notHost.join('.') + rest;
            }
            this.hostname = validParts.join('.');
            break;
          }
        }
      }
    }

    if (this.hostname.length > hostnameMaxLen) {
      this.hostname = '';
    } else {
      // hostnames are always lower case.
      this.hostname = this.hostname.toLowerCase();
    }

    if (!ipv6Hostname) {
      // IDNA Support: Returns a punycoded representation of "domain".
      // It only converts parts of the domain name that
      // have non-ASCII characters, i.e. it doesn't matter if
      // you call it with a domain that already is ASCII-only.
      this.hostname = punycode.toASCII(this.hostname);
    }

    var p = this.port ? ':' + this.port : '';
    var h = this.hostname || '';
    this.host = h + p;
    this.href += this.host;

    // strip [ and ] from the hostname
    // the host field still retains them, though
    if (ipv6Hostname) {
      this.hostname = this.hostname.substr(1, this.hostname.length - 2);
      if (rest[0] !== '/') {
        rest = '/' + rest;
      }
    }
  }

  // now rest is set to the post-host stuff.
  // chop off any delim chars.
  if (!unsafeProtocol[lowerProto]) {

    // First, make 100% sure that any "autoEscape" chars get
    // escaped, even if encodeURIComponent doesn't think they
    // need to be.
    for (var i = 0, l = autoEscape.length; i < l; i++) {
      var ae = autoEscape[i];
      if (rest.indexOf(ae) === -1)
        continue;
      var esc = encodeURIComponent(ae);
      if (esc === ae) {
        esc = escape(ae);
      }
      rest = rest.split(ae).join(esc);
    }
  }


  // chop off from the tail first.
  var hash = rest.indexOf('#');
  if (hash !== -1) {
    // got a fragment string.
    this.hash = rest.substr(hash);
    rest = rest.slice(0, hash);
  }
  var qm = rest.indexOf('?');
  if (qm !== -1) {
    this.search = rest.substr(qm);
    this.query = rest.substr(qm + 1);
    if (parseQueryString) {
      this.query = querystring.parse(this.query);
    }
    rest = rest.slice(0, qm);
  } else if (parseQueryString) {
    // no query string, but parseQueryString still requested
    this.search = '';
    this.query = {};
  }
  if (rest) this.pathname = rest;
  if (slashedProtocol[lowerProto] &&
      this.hostname && !this.pathname) {
    this.pathname = '/';
  }

  //to support http.request
  if (this.pathname || this.search) {
    var p = this.pathname || '';
    var s = this.search || '';
    this.path = p + s;
  }

  // finally, reconstruct the href based on what has been validated.
  this.href = this.format();
  return this;
};

// format a parsed object into a url string
function urlFormat(obj) {
  // ensure it's an object, and not a string url.
  // If it's an obj, this is a no-op.
  // this way, you can call url_format() on strings
  // to clean up potentially wonky urls.
  if (util.isString(obj)) obj = urlParse(obj);
  if (!(obj instanceof Url)) return Url.prototype.format.call(obj);
  return obj.format();
}

Url.prototype.format = function() {
  var auth = this.auth || '';
  if (auth) {
    auth = encodeURIComponent(auth);
    auth = auth.replace(/%3A/i, ':');
    auth += '@';
  }

  var protocol = this.protocol || '',
      pathname = this.pathname || '',
      hash = this.hash || '',
      host = false,
      query = '';

  if (this.host) {
    host = auth + this.host;
  } else if (this.hostname) {
    host = auth + (this.hostname.indexOf(':') === -1 ?
        this.hostname :
        '[' + this.hostname + ']');
    if (this.port) {
      host += ':' + this.port;
    }
  }

  if (this.query &&
      util.isObject(this.query) &&
      Object.keys(this.query).length) {
    query = querystring.stringify(this.query);
  }

  var search = this.search || (query && ('?' + query)) || '';

  if (protocol && protocol.substr(-1) !== ':') protocol += ':';

  // only the slashedProtocols get the //.  Not mailto:, xmpp:, etc.
  // unless they had them to begin with.
  if (this.slashes ||
      (!protocol || slashedProtocol[protocol]) && host !== false) {
    host = '//' + (host || '');
    if (pathname && pathname.charAt(0) !== '/') pathname = '/' + pathname;
  } else if (!host) {
    host = '';
  }

  if (hash && hash.charAt(0) !== '#') hash = '#' + hash;
  if (search && search.charAt(0) !== '?') search = '?' + search;

  pathname = pathname.replace(/[?#]/g, function(match) {
    return encodeURIComponent(match);
  });
  search = search.replace('#', '%23');

  return protocol + host + pathname + search + hash;
};

function urlResolve(source, relative) {
  return urlParse(source, false, true).resolve(relative);
}

Url.prototype.resolve = function(relative) {
  return this.resolveObject(urlParse(relative, false, true)).format();
};

function urlResolveObject(source, relative) {
  if (!source) return relative;
  return urlParse(source, false, true).resolveObject(relative);
}

Url.prototype.resolveObject = function(relative) {
  if (util.isString(relative)) {
    var rel = new Url();
    rel.parse(relative, false, true);
    relative = rel;
  }

  var result = new Url();
  var tkeys = Object.keys(this);
  for (var tk = 0; tk < tkeys.length; tk++) {
    var tkey = tkeys[tk];
    result[tkey] = this[tkey];
  }

  // hash is always overridden, no matter what.
  // even href="" will remove it.
  result.hash = relative.hash;

  // if the relative url is empty, then there's nothing left to do here.
  if (relative.href === '') {
    result.href = result.format();
    return result;
  }

  // hrefs like //foo/bar always cut to the protocol.
  if (relative.slashes && !relative.protocol) {
    // take everything except the protocol from relative
    var rkeys = Object.keys(relative);
    for (var rk = 0; rk < rkeys.length; rk++) {
      var rkey = rkeys[rk];
      if (rkey !== 'protocol')
        result[rkey] = relative[rkey];
    }

    //urlParse appends trailing / to urls like http://www.example.com
    if (slashedProtocol[result.protocol] &&
        result.hostname && !result.pathname) {
      result.path = result.pathname = '/';
    }

    result.href = result.format();
    return result;
  }

  if (relative.protocol && relative.protocol !== result.protocol) {
    // if it's a known url protocol, then changing
    // the protocol does weird things
    // first, if it's not file:, then we MUST have a host,
    // and if there was a path
    // to begin with, then we MUST have a path.
    // if it is file:, then the host is dropped,
    // because that's known to be hostless.
    // anything else is assumed to be absolute.
    if (!slashedProtocol[relative.protocol]) {
      var keys = Object.keys(relative);
      for (var v = 0; v < keys.length; v++) {
        var k = keys[v];
        result[k] = relative[k];
      }
      result.href = result.format();
      return result;
    }

    result.protocol = relative.protocol;
    if (!relative.host && !hostlessProtocol[relative.protocol]) {
      var relPath = (relative.pathname || '').split('/');
      while (relPath.length && !(relative.host = relPath.shift()));
      if (!relative.host) relative.host = '';
      if (!relative.hostname) relative.hostname = '';
      if (relPath[0] !== '') relPath.unshift('');
      if (relPath.length < 2) relPath.unshift('');
      result.pathname = relPath.join('/');
    } else {
      result.pathname = relative.pathname;
    }
    result.search = relative.search;
    result.query = relative.query;
    result.host = relative.host || '';
    result.auth = relative.auth;
    result.hostname = relative.hostname || relative.host;
    result.port = relative.port;
    // to support http.request
    if (result.pathname || result.search) {
      var p = result.pathname || '';
      var s = result.search || '';
      result.path = p + s;
    }
    result.slashes = result.slashes || relative.slashes;
    result.href = result.format();
    return result;
  }

  var isSourceAbs = (result.pathname && result.pathname.charAt(0) === '/'),
      isRelAbs = (
          relative.host ||
          relative.pathname && relative.pathname.charAt(0) === '/'
      ),
      mustEndAbs = (isRelAbs || isSourceAbs ||
                    (result.host && relative.pathname)),
      removeAllDots = mustEndAbs,
      srcPath = result.pathname && result.pathname.split('/') || [],
      relPath = relative.pathname && relative.pathname.split('/') || [],
      psychotic = result.protocol && !slashedProtocol[result.protocol];

  // if the url is a non-slashed url, then relative
  // links like ../.. should be able
  // to crawl up to the hostname, as well.  This is strange.
  // result.protocol has already been set by now.
  // Later on, put the first path part into the host field.
  if (psychotic) {
    result.hostname = '';
    result.port = null;
    if (result.host) {
      if (srcPath[0] === '') srcPath[0] = result.host;
      else srcPath.unshift(result.host);
    }
    result.host = '';
    if (relative.protocol) {
      relative.hostname = null;
      relative.port = null;
      if (relative.host) {
        if (relPath[0] === '') relPath[0] = relative.host;
        else relPath.unshift(relative.host);
      }
      relative.host = null;
    }
    mustEndAbs = mustEndAbs && (relPath[0] === '' || srcPath[0] === '');
  }

  if (isRelAbs) {
    // it's absolute.
    result.host = (relative.host || relative.host === '') ?
                  relative.host : result.host;
    result.hostname = (relative.hostname || relative.hostname === '') ?
                      relative.hostname : result.hostname;
    result.search = relative.search;
    result.query = relative.query;
    srcPath = relPath;
    // fall through to the dot-handling below.
  } else if (relPath.length) {
    // it's relative
    // throw away the existing file, and take the new path instead.
    if (!srcPath) srcPath = [];
    srcPath.pop();
    srcPath = srcPath.concat(relPath);
    result.search = relative.search;
    result.query = relative.query;
  } else if (!util.isNullOrUndefined(relative.search)) {
    // just pull out the search.
    // like href='?foo'.
    // Put this after the other two cases because it simplifies the booleans
    if (psychotic) {
      result.hostname = result.host = srcPath.shift();
      //occationaly the auth can get stuck only in host
      //this especially happens in cases like
      //url.resolveObject('mailto:local1@domain1', 'local2@domain2')
      var authInHost = result.host && result.host.indexOf('@') > 0 ?
                       result.host.split('@') : false;
      if (authInHost) {
        result.auth = authInHost.shift();
        result.host = result.hostname = authInHost.shift();
      }
    }
    result.search = relative.search;
    result.query = relative.query;
    //to support http.request
    if (!util.isNull(result.pathname) || !util.isNull(result.search)) {
      result.path = (result.pathname ? result.pathname : '') +
                    (result.search ? result.search : '');
    }
    result.href = result.format();
    return result;
  }

  if (!srcPath.length) {
    // no path at all.  easy.
    // we've already handled the other stuff above.
    result.pathname = null;
    //to support http.request
    if (result.search) {
      result.path = '/' + result.search;
    } else {
      result.path = null;
    }
    result.href = result.format();
    return result;
  }

  // if a url ENDs in . or .., then it must get a trailing slash.
  // however, if it ends in anything else non-slashy,
  // then it must NOT get a trailing slash.
  var last = srcPath.slice(-1)[0];
  var hasTrailingSlash = (
      (result.host || relative.host || srcPath.length > 1) &&
      (last === '.' || last === '..') || last === '');

  // strip single dots, resolve double dots to parent dir
  // if the path tries to go above the root, `up` ends up > 0
  var up = 0;
  for (var i = srcPath.length; i >= 0; i--) {
    last = srcPath[i];
    if (last === '.') {
      srcPath.splice(i, 1);
    } else if (last === '..') {
      srcPath.splice(i, 1);
      up++;
    } else if (up) {
      srcPath.splice(i, 1);
      up--;
    }
  }

  // if the path is allowed to go above the root, restore leading ..s
  if (!mustEndAbs && !removeAllDots) {
    for (; up--; up) {
      srcPath.unshift('..');
    }
  }

  if (mustEndAbs && srcPath[0] !== '' &&
      (!srcPath[0] || srcPath[0].charAt(0) !== '/')) {
    srcPath.unshift('');
  }

  if (hasTrailingSlash && (srcPath.join('/').substr(-1) !== '/')) {
    srcPath.push('');
  }

  var isAbsolute = srcPath[0] === '' ||
      (srcPath[0] && srcPath[0].charAt(0) === '/');

  // put the host back
  if (psychotic) {
    result.hostname = result.host = isAbsolute ? '' :
                                    srcPath.length ? srcPath.shift() : '';
    //occationaly the auth can get stuck only in host
    //this especially happens in cases like
    //url.resolveObject('mailto:local1@domain1', 'local2@domain2')
    var authInHost = result.host && result.host.indexOf('@') > 0 ?
                     result.host.split('@') : false;
    if (authInHost) {
      result.auth = authInHost.shift();
      result.host = result.hostname = authInHost.shift();
    }
  }

  mustEndAbs = mustEndAbs || (result.host && srcPath.length);

  if (mustEndAbs && !isAbsolute) {
    srcPath.unshift('');
  }

  if (!srcPath.length) {
    result.pathname = null;
    result.path = null;
  } else {
    result.pathname = srcPath.join('/');
  }

  //to support request.http
  if (!util.isNull(result.pathname) || !util.isNull(result.search)) {
    result.path = (result.pathname ? result.pathname : '') +
                  (result.search ? result.search : '');
  }
  result.auth = relative.auth || result.auth;
  result.slashes = result.slashes || relative.slashes;
  result.href = result.format();
  return result;
};

Url.prototype.parseHost = function() {
  var host = this.host;
  var port = portPattern.exec(host);
  if (port) {
    port = port[0];
    if (port !== ':') {
      this.port = port.substr(1);
    }
    host = host.substr(0, host.length - port.length);
  }
  if (host) this.hostname = host;
};

});
$_mod.def("/browser-refresh-taglib$1.1.0/refresh-tag", function(require, exports, module, __filename, __dirname) { var process=require("process"); var url = require('/url$0.11.0/url'/*'url'*/);

var scriptUrl = process.env.BROWSER_REFRESH_URL;
if (!scriptUrl) {
    var port = process.env.BROWSER_REFRESH_PORT;
    if (port) {
        scriptUrl = 'http://localhost:' + port + '/browser-refresh.js';
    }
}

var enabled = scriptUrl != null;
var parsedUrl;

if (enabled) {
    parsedUrl = url.parse(scriptUrl);
    delete parsedUrl.host;
}

function getHostName(out) {
    var req = out.global && out.global.req;

    if (!req) {
        // out.stream will be `res` if rendering directly to `res`
        req = out.stream && out.stream.req;
    }

    return req && req.hostname;
}

/**
 * Updates the browser refresh URL to use the host name
 * associated with the incoming request instead of the
 * default "localhost"
 */
function resolveUrl(out) {
    var hostname = getHostName(out);
    if (!hostname) {
        // If we could not determine the hostname then just
        // return the default browser refresh script URL
        return scriptUrl;
    }

    // Mutate the parsed URL to use the incoming hostname
    parsedUrl.hostname = hostname;

    // Convert the parsed URL back into a string URL with the new hostname
    return url.format(parsedUrl);
}

exports.render = function(input, out) {
    if (enabled && input.enabled !== false) {
        out.write('<script src="' + resolveUrl(out) + '"></script>');
    }
};
});
$_mod.main("/myebaynode$1.0.0/src/fe-components/m-toast", "index.marko");
$_mod.def("/myebaynode$1.0.0/src/fe-components/m-toast/component", function(require, exports, module, __filename, __dirname) { 'use strict';

const pubsub = require('/myebaynode$1.0.0/src/common-utils/pubsub/index'/*'src/common-utils/pubsub'*/);
const r = require('/@ebay/retriever$1.0.0/index'/*'@ebay/retriever'*/);
module.exports = {
    onInput(input) {
        return input;
    },
    onMount() {
        this.pubsubRegister();
    },
    pubsubRegister() {
        pubsub.on('SHOW_TOAST', this.showToast, this);
        pubsub.on('HIDE_TOAST', this.hideToast, this);
    },
    showToast(data) {
        $(this.getEl('m-toast')).find('.info-msg').text(r.get(data, 'msg', ''));
        $(".m-toast").addClass("active");
        setTimeout(() => {
            pubsub.emit('HIDE_TOAST', this);
        }, 4000);
    },
    hideToast() {
        $(".m-toast").removeClass("active");
    }
};

});
$_mod.def("/myebaynode$1.0.0/src/fe-components/m-toast/index.marko", function(require, exports, module, __filename, __dirname) { // Compiled using marko@4.4.28 - DO NOT EDIT
"use strict";

var marko_template = module.exports = require('/marko$4.4.28/src/vdom'/*"marko/src/vdom"*/).t(),
    components_helpers = require('/marko$4.4.28/src/components/helpers-browser'/*"marko/src/components/helpers"*/),
    marko_registerComponent = components_helpers.rc,
    marko_componentType = marko_registerComponent("/myebaynode$1.0.0/src/fe-components/m-toast/index.marko", function() {
      return module.exports;
    }),
    marko_component = require('/myebaynode$1.0.0/src/fe-components/m-toast/component'/*"./component"*/),
    marko_renderer = components_helpers.r,
    marko_defineComponent = components_helpers.c,
    marko_helpers = require('/marko$4.4.28/src/runtime/vdom/helpers'/*"marko/src/runtime/vdom/helpers"*/),
    marko_createElement = marko_helpers.e,
    marko_const = marko_helpers.const,
    marko_const_nextId = marko_const("72cdf8"),
    marko_node0 = marko_createElement("DIV", {
        "class": "m-toast__msg"
      }, 2, 0, {
        c: marko_const_nextId()
      })
      .e("SPAN", {
          "class": "info-icon"
        }, 1)
        .e("svg", {
            "aria-hidden": "true",
            focusable: "false",
            width: "16",
            height: "16"
          }, 1, 1)
          .e("use", {
              "xlink:href": "#svg-icon-exclamation"
            }, 0, 1)
      .e("SPAN", {
          "class": "info-msg",
          role: "alert"
        }, 0);

function render(input, out, __component, component, state) {
  var data = input;

  out.e("DIV", {
      "class": "m-toast",
      id: __component.elId("m-toast")
    }, 1, 4)
    .n(marko_node0);
}

marko_template._ = marko_renderer(render, {
    type: marko_componentType,
    roots: [
      "m-toast"
    ]
  }, marko_component);

marko_template.Component = marko_defineComponent(marko_component, marko_template._);

});
$_mod.def("/myebaynode$1.0.0/src/fe-components/m-common/index.marko", function(require, exports, module, __filename, __dirname) { // Compiled using marko@4.4.28 - DO NOT EDIT
"use strict";

var marko_template = module.exports = require('/marko$4.4.28/src/vdom'/*"marko/src/vdom"*/).t(),
    components_helpers = require('/marko$4.4.28/src/components/helpers-browser'/*"marko/src/components/helpers"*/),
    marko_registerComponent = components_helpers.rc,
    marko_componentType = marko_registerComponent("/myebaynode$1.0.0/src/fe-components/m-common/index.marko", function() {
      return module.exports;
    }),
    marko_component = require('/myebaynode$1.0.0/src/fe-components/m-common/component'/*"./component"*/),
    marko_renderer = components_helpers.r,
    marko_defineComponent = components_helpers.c,
    m_lazy_template = require('/myebaynode$1.0.0/src/fe-components/m-lazy/index.marko'/*"../m-lazy"*/),
    marko_helpers = require('/marko$4.4.28/src/runtime/vdom/helpers'/*"marko/src/runtime/vdom/helpers"*/),
    marko_loadTag = marko_helpers.t,
    m_lazy_tag = marko_loadTag(m_lazy_template),
    lasso_body_tag = marko_loadTag(require('/lasso$2.11.24/taglib/noop-render'/*"lasso/taglib/body-tag"*/)),
    lasso_slot_tag = marko_loadTag(require('/lasso$2.11.24/taglib/noop-render'/*"lasso/taglib/slot-tag"*/)),
    browser_refresh_tag = marko_loadTag(require('/browser-refresh-taglib$1.1.0/refresh-tag'/*"browser-refresh-taglib/refresh-tag"*/)),
    m_toast_template = require('/myebaynode$1.0.0/src/fe-components/m-toast/index.marko'/*"../m-toast"*/),
    m_toast_tag = marko_loadTag(m_toast_template),
    marko_createElement = marko_helpers.e,
    marko_const = marko_helpers.const,
    marko_const_nextId = marko_const("61d7aa"),
    marko_node0 = marko_createElement("DIV", {
        "class": "dialog__mask dialog__mask--fade hide"
      }, 0, 0, {
        c: marko_const_nextId()
      }),
    marko_node1 = marko_createElement("svg", {
        hidden: true
      }, 15, 1, {
        c: marko_const_nextId()
      })
      .e("symbol", {
          id: "svg-icon-chevron-left",
          viewBox: "0 0 32 32"
        }, 1, 1)
        .e("path", {
            d: "M25.137 3.838l-15.393 15.389-3.265-3.264 15.393-15.393 3.265 3.267zM9.745 12.698l15.394 15.393-3.265 3.267-15.394-15.393 3.266-3.266zM9.745 19.227v0zM6.479 15.964v0z"
          }, 0, 1)
      .e("symbol", {
          id: "svg-icon-chevron-right",
          viewBox: "0 0 32 32"
        }, 1, 1)
        .e("path", {
            d: "M7.060 27.985l15.291-15.288 3.244 3.242-15.291 15.291-3.245-3.245zM22.352 19.183l-15.291-15.291 3.245-3.244 15.292 15.292-3.244 3.244zM22.352 12.697v0zM25.596 15.94v0z"
          }, 0, 1)
      .e("symbol", {
          id: "svg-icon-close",
          viewBox: "0 0 32 32"
        }, 1, 1)
        .e("path", {
            d: "M31.427 2.846l-2.387-2.387-13.084 13.082-13.082-13.082-2.386 2.387 13.082 13.082-13.082 13.084 2.386 2.386 13.082-13.082 13.084 13.082 2.386-2.386-13.084-13.084z"
          }, 0, 1)
      .e("symbol", {
          id: "svg-icon-chevron-up",
          viewBox: "0 0 32 32"
        }, 1, 1)
        .e("path", {
            d: "M28.128 25.744l-15.389-15.393 3.263-3.265 15.392 15.394-3.267 3.264zM19.267 10.351l-15.393 15.393-3.267-3.265 15.394-15.393 3.265 3.265zM12.738 10.351v0zM16.002 7.086v0z"
          }, 0, 1)
      .e("symbol", {
          id: "svg-icon-chevron-down",
          viewBox: "0 0 32 32"
        }, 1, 1)
        .e("path", {
            d: "M3.873 6.636l15.389 15.392-3.264 3.265-15.393-15.393 3.267-3.265zM12.734 22.029l15.393-15.393 3.267 3.265-15.394 15.393-3.265-3.265zM19.263 22.029v0zM15.999 25.294v0z"
          }, 0, 1)
      .e("symbol", {
          id: "svg-icon-priority",
          viewBox: "0 0 32 32"
        }, 3, 1)
        .e("path", {
            fill: "#dd1e31",
            d: "M15.991 18.996c0 0 0 0 0 0-0.625 0-1.132-0.507-1.132-1.132 0 0 0 0 0 0v-8.737c-0.006-0.043-0.009-0.094-0.009-0.145 0-0.625 0.507-1.132 1.132-1.132s1.132 0.507 1.132 1.132c0 0.051-0.003 0.101-0.010 0.15l0.001 8.732c0 0 0 0 0 0 0 0.618-0.496 1.121-1.112 1.131z"
          }, 0, 1)
        .e("path", {
            fill: "#dd1e31",
            d: "M17.401 22.855c0 0.748-0.606 1.354-1.354 1.354s-1.354-0.606-1.354-1.354c0-0.748 0.606-1.354 1.354-1.354s1.354 0.606 1.354 1.354z"
          }, 0, 1)
        .e("path", {
            fill: "#dd1e31",
            d: "M15.991 32c-8.842 0-16.009-7.168-16.009-16.009s7.168-16.009 16.009-16.009c8.842 0 16.009 7.168 16.009 16.009 0 0.007 0 0.013 0 0.020-0.011 8.833-7.174 15.99-16.009 15.99 0 0 0 0 0 0zM15.991 2.319c0 0 0 0 0 0-7.561 0-13.69 6.129-13.69 13.69s6.129 13.69 13.69 13.69c7.561 0 13.69-6.129 13.69-13.69s-6.129-13.69-13.69-13.69z"
          }, 0, 1)
      .e("symbol", {
          id: "svg-icon-information",
          viewBox: "0 0 32 32"
        }, 3, 1)
        .e("path", {
            fill: "#0654ba",
            d: "M15.991 12.986c0 0 0 0 0 0-0.625 0-1.132 0.507-1.132 1.132 0 0 0 0 0 0v8.737c0.074 0.56 0.548 0.987 1.122 0.987s1.048-0.427 1.122-0.981l0.001-8.743c0-0 0-0 0-0 0-0.618-0.496-1.121-1.112-1.131z"
          }, 0, 1)
        .e("path", {
            fill: "#0654ba",
            d: "M17.401 9.146c0 0.748-0.606 1.354-1.354 1.354s-1.354-0.606-1.354-1.354c0-0.748 0.606-1.354 1.354-1.354s1.354 0.606 1.354 1.354z"
          }, 0, 1)
        .e("path", {
            fill: "#0654ba",
            d: "M15.991 32c-8.842 0-16.009-7.168-16.009-16.009s7.168-16.009 16.009-16.009c8.842 0 16.009 7.168 16.009 16.009 0 0.007 0 0.013 0 0.020-0.011 8.833-7.174 15.99-16.009 15.99 0 0 0 0 0 0zM15.991 2.319c0 0 0 0 0 0-7.561 0-13.69 6.129-13.69 13.69s6.129 13.69 13.69 13.69c7.561 0 13.69-6.129 13.69-13.69s-6.129-13.69-13.69-13.69z"
          }, 0, 1)
      .e("symbol", {
          id: "svg-icon-confirmation",
          viewBox: "0 0 32 32"
        }, 2, 1)
        .e("path", {
            fill: "#5ba71b",
            d: "M16.009 32c-8.842 0-16.009-7.168-16.009-16.009s7.168-16.009 16.009-16.009c8.842 0 16.009 7.168 16.009 16.009 0 0.007 0 0.013 0 0.020-0.011 8.833-7.174 15.99-16.009 15.99 0 0 0 0 0 0zM16.009 2.319c0 0 0 0 0 0-7.561 0-13.69 6.129-13.69 13.69s6.129 13.69 13.69 13.69c7.561 0 13.69-6.129 13.69-13.69s-6.129-13.69-13.69-13.69z"
          }, 0, 1)
        .e("path", {
            fill: "#5ba71b",
            d: "M14.841 23.448c-0.001 0-0.003 0-0.004 0-0.247 0-0.473-0.091-0.646-0.242l-6.232-5.305c-0.213-0.182-0.347-0.451-0.347-0.751 0-0.545 0.442-0.987 0.987-0.987 0.245 0 0.469 0.089 0.641 0.237l5.434 4.637 8.181-10.741c0.183-0.238 0.468-0.39 0.788-0.39 0.548 0 0.992 0.444 0.992 0.992 0 0.228-0.077 0.438-0.206 0.605l-8.81 11.573c-0.137 0.199-0.39 0.358-0.682 0.389l-0.116 0z"
          }, 0, 1)
      .e("symbol", {
          id: "svg-icon-exclamation",
          viewBox: "0 0 32 32"
        }, 3, 1)
        .e("path", {
            d: "M15.991 12.986c0 0 0 0 0 0-0.625 0-1.132 0.507-1.132 1.132 0 0 0 0 0 0v8.737c0.074 0.56 0.548 0.987 1.122 0.987s1.048-0.427 1.122-0.981l0.001-8.743c0-0 0-0 0-0 0-0.618-0.496-1.121-1.112-1.131z"
          }, 0, 1)
        .e("path", {
            d: "M17.401 9.146c0 0.748-0.606 1.354-1.354 1.354s-1.354-0.606-1.354-1.354c0-0.748 0.606-1.354 1.354-1.354s1.354 0.606 1.354 1.354z"
          }, 0, 1)
        .e("path", {
            d: "M15.991 32c-8.842 0-16.009-7.168-16.009-16.009s7.168-16.009 16.009-16.009c8.842 0 16.009 7.168 16.009 16.009 0 0.007 0 0.013 0 0.020-0.011 8.833-7.174 15.99-16.009 15.99 0 0 0 0 0 0zM15.991 2.319c0 0 0 0 0 0-7.561 0-13.69 6.129-13.69 13.69s6.129 13.69 13.69 13.69c7.561 0 13.69-6.129 13.69-13.69s-6.129-13.69-13.69-13.69z"
          }, 0, 1)
      .e("symbol", {
          id: "svg-icon-bookmark"
        }, 1, 1)
        .e("g", {
            stroke: "none",
            "stroke-width": "1",
            fill: "none",
            "fill-rule": "evenodd"
          }, 1, 1)
          .e("g", {
              transform: "translate(-1386.000000, -241.000000)",
              stroke: "#767676"
            }, 1, 1)
            .e("path", {
                d: "M1387 242 1397 242 1397 258 1391.9562 251.97358 1387 258z"
              }, 0, 1)
      .e("symbol", {
          id: "svg-icon-menu",
          viewBox: "0 0 32 32"
        }, 3, 1)
        .e("path", {
            d: "M32.312 7.493h-24.039c-0.624 0-1.171-0.468-1.171-1.171s0.546-1.171 1.171-1.171h24.039c0.624 0 1.171 0.546 1.171 1.171s-0.546 1.171-1.171 1.171z"
          }, 0, 1)
        .e("path", {
            d: "M32.312 26.849h-24.039c-0.624 0-1.171-0.546-1.171-1.171s0.546-1.171 1.171-1.171h24.039c0.624 0 1.171 0.546 1.171 1.171s-0.546 1.171-1.171 1.171z"
          }, 0, 1)
        .e("path", {
            d: "M32.312 16.859h-24.039c-0.624 0-1.171-0.546-1.171-1.171s0.546-1.171 1.171-1.171h24.039c0.624 0 1.171 0.546 1.171 1.171s-0.546 1.171-1.171 1.171z"
          }, 0, 1)
      .e("defs", null, 1, 1)
        .e("style", null, 1, 1)
          .t("\n                .m-cta-svg {\n                    fill: none;\n                    stroke-miterlimit: 0;\n                    stroke-width: 2px;\n                }\n            ")
      .e("symbol", {
          id: "svg-icon-right-arrow",
          viewBox: "0 0 32 32"
        }, 2, 1)
        .e("polyline", {
            "vector-effect": "non-scaling-stroke",
            "class": "m-cta-svg",
            points: "23.16 29.55 37.52 15.13 23.16 0.7"
          }, 0, 1)
        .e("line", {
            "vector-effect": "non-scaling-stroke",
            "class": "m-cta-svg",
            x1: "37.51",
            y1: "15.13",
            y2: "15.13"
          }, 0, 1)
      .e("symbol", {
          id: "svg-icon-checkbox-unchecked",
          viewBox: "0 0 14 14"
        }, 3, 1)
        .e("path", {
            d: "M13.8030125,0 L0.196987541,0 C0.0885142255,0 0,0.0873234269 0,0.19433743 L0,13.8056626 C0,13.9126766 0.0885142255,14 0.196987541,14 L13.8030125,14 C13.9114858,14 14,13.9126766 14,13.8056626 L14,0.19433743 C14,0.0873234269 13.9114858,0 13.8030125,0 L13.8030125,0 Z",
            id: "path-1"
          }, 0, 1)
        .e("use", {
            fill: "#FFFFFF",
            "fill-rule": "evenodd",
            "xlink:href": "#path-1"
          }, 0, 1)
        .e("path", {
            stroke: "#4F4F4F",
            "stroke-width": "1",
            d: "M13.5,0.5 L0.5,0.5 L0.5,13.5 L13.5,13.5 L13.5,0.5 Z"
          }, 0, 1)
      .e("symbol", {
          id: "svg-icon-checkbox-checked",
          viewBox: "0 0 14 14"
        }, 2, 1)
        .e("path", {
            d: "M13.8030125,0 C13.9114858,0 14,0.0873234269 14,0.19433743 L14,13.8056626 C14,13.9126766 13.9114858,14 13.8030125,14 L0.196987541,14 C0.0885142255,14 0,13.9126766 0,13.8056626 L0,0.19433743 C0,0.0873234269 0.0885142255,0 0.196987541,0 L13.8030125,0 Z",
            id: "Box",
            fill: "#006EFC"
          }, 0, 1)
        .e("polyline", {
            id: "Tick",
            stroke: "#FFFFFF",
            "stroke-width": "1.5",
            points: "3 7.25095863 5.52628285 10 11 4"
          }, 0, 1),
    marko_node2 = marko_createElement("SCRIPT", {
        type: "text/javascript"
      }, 1, 0, {
        c: marko_const_nextId()
      })
      .t("\n            (function() {\n                var qtm = document.createElement('script'); qtm.type = 'text/javascript'; qtm.async = 1;\n                qtm.src = 'https://cdn.quantummetric.com/qscripts/quantum-ebay.js';\n                var d = document.getElementsByTagName('script')[0]; !window.QuantumMetricAPI && d.parentNode.insertBefore(qtm, d);\n            })();\n        ");

function render(input, out, __component, component, state) {
  var data = input;

  const r = require('/@ebay/retriever$1.0.0/index'/*'@ebay/retriever'*/);

  const enableQTM = r.get(data,'configs.enableQTM',false);

  out.be("DIV", {
      id: __component.elId("common-wrapper")
    }, null, 4);

  out.n(marko_node0);

  if (data.enableLazyLoad) {
    m_lazy_tag({}, out);
  }

  lasso_body_tag({}, out);

  lasso_slot_tag({
      name: "common-js"
    }, out);

  browser_refresh_tag({}, out);

  m_toast_tag({}, out);

  out.n(marko_node1);

  if (enableQTM) {
    out.n(marko_node2);
  }

  out.ee();
}

marko_template._ = marko_renderer(render, {
    type: marko_componentType,
    roots: [
      "common-wrapper"
    ]
  }, marko_component);

marko_template.Component = marko_defineComponent(marko_component, marko_template._);

});
$_mod.installed("myebaynode$1.0.0", "makeup-expander", "0.0.3");
$_mod.main("/makeup-expander$0.0.3", "");
$_mod.installed("makeup-expander$0.0.3", "custom-event-polyfill", "0.3.0");
$_mod.main("/custom-event-polyfill$0.3.0", "custom-event-polyfill");
$_mod.def("/custom-event-polyfill$0.3.0/custom-event-polyfill", function(require, exports, module, __filename, __dirname) { // Polyfill for creating CustomEvents on IE9/10/11

// code pulled from:
// https://github.com/d4tocchini/customevent-polyfill
// https://developer.mozilla.org/en-US/docs/Web/API/CustomEvent#Polyfill

try {
    var ce = new window.CustomEvent('test');
    ce.preventDefault();
    if (ce.defaultPrevented !== true) {
        // IE has problems with .preventDefault() on custom events
        // http://stackoverflow.com/questions/23349191
        throw new Error('Could not prevent default');
    }
} catch(e) {
  var CustomEvent = function(event, params) {
    var evt, origPrevent;
    params = params || {
      bubbles: false,
      cancelable: false,
      detail: undefined
    };

    evt = document.createEvent("CustomEvent");
    evt.initCustomEvent(event, params.bubbles, params.cancelable, params.detail);
    origPrevent = evt.preventDefault;
    evt.preventDefault = function () {
      origPrevent.call(this);
      try {
        Object.defineProperty(this, 'defaultPrevented', {
          get: function () {
            return true;
          }
        });
      } catch(e) {
        this.defaultPrevented = true;
      }
    };
    return evt;
  };

  CustomEvent.prototype = window.Event.prototype;
  window.CustomEvent = CustomEvent; // expose definition to window
}

});
$_mod.run("/custom-event-polyfill$0.3.0/custom-event-polyfill");
$_mod.installed("makeup-expander$0.0.3", "makeup-next-id", "0.0.1");
$_mod.main("/makeup-next-id$0.0.1", "");
$_mod.def("/makeup-next-id$0.0.1/index", function(require, exports, module, __filename, __dirname) { 'use strict';

var sequenceMap = {};
var defaultPrefix = 'nid';

module.exports = function (el) {
    var prefix = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : defaultPrefix;

    // prevent empty string
    var _prefix = prefix === '' ? defaultPrefix : prefix;

    // initialise prefix in sequence map if necessary
    sequenceMap[_prefix] = sequenceMap[_prefix] || 0;

    if (!el.id) {
        el.setAttribute('id', _prefix + '-' + sequenceMap[_prefix]++);
    }
};
});
$_mod.installed("makeup-expander$0.0.3", "makeup-exit-emitter", "0.0.2");
$_mod.main("/makeup-exit-emitter$0.0.2", "");
$_mod.installed("makeup-exit-emitter$0.0.2", "custom-event-polyfill", "0.3.0");
$_mod.def("/makeup-exit-emitter$0.0.2/index", function(require, exports, module, __filename, __dirname) { 'use strict';

// requires CustomEvent polyfill for IE9+
// https://developer.mozilla.org/en-US/docs/Web/API/CustomEvent/CustomEvent

function onFocusOrMouseOut(evt, el, type) {
    if (el.contains(evt.relatedTarget) === false) {
        el.dispatchEvent(new CustomEvent(type + 'Exit', {
            detail: {
                toElement: evt.relatedTarget,
                fromElement: evt.target
            },
            bubbles: false // mirror the native mouseleave event
        }));
    }
}

function onFocusOut(e) {
    onFocusOrMouseOut(e, this, 'focus');
}

function onMouseOut(e) {
    onFocusOrMouseOut(e, this, 'mouse');
}

function addFocusExit(el) {
    el.addEventListener('focusout', onFocusOut);
}

function removeFocusExit(el) {
    el.removeEventListener('focusout', onFocusOut);
}

function addMouseExit(el) {
    el.addEventListener('mouseout', onMouseOut);
}

function removeMouseExit(el) {
    el.removeEventListener('mouseout', onMouseOut);
}

function add(el) {
    addFocusExit(el);
    addMouseExit(el);
}

function remove(el) {
    removeFocusExit(el);
    removeMouseExit(el);
}

module.exports = {
    addFocusExit: addFocusExit,
    addMouseExit: addMouseExit,
    removeFocusExit: removeFocusExit,
    removeMouseExit: removeMouseExit,
    add: add,
    remove: remove
};
});
$_mod.installed("makeup-expander$0.0.3", "makeup-focusables", "0.0.1");
$_mod.main("/makeup-focusables$0.0.1", "");
$_mod.def("/makeup-focusables$0.0.1/index", function(require, exports, module, __filename, __dirname) { 'use strict';

var focusableElList = ['a[href]', 'area[href]', 'button:not([disabled])', 'embed', 'iframe', 'input:not([disabled])', 'object', 'select:not([disabled])', 'textarea:not([disabled])', '*[tabindex]', '*[contenteditable]'];

var focusableElSelector = focusableElList.join();

module.exports = function (el) {
    var keyboardOnly = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : false;

    var focusableEls = Array.prototype.slice.call(el.querySelectorAll(focusableElSelector));

    if (keyboardOnly === true) {
        focusableEls = focusableEls.filter(function (focusableEl) {
            return focusableEl.getAttribute('tabindex') !== '-1';
        });
    }

    return focusableEls;
};
});
$_mod.def("/makeup-expander$0.0.3/index", function(require, exports, module, __filename, __dirname) { 'use strict';

var _extends = Object.assign || function (target) {
    for (var i = 1; i < arguments.length; i++) {
        var source = arguments[i];for (var key in source) {
            if (Object.prototype.hasOwnProperty.call(source, key)) {
                target[key] = source[key];
            }
        }
    }return target;
};

var _createClass = function () {
    function defineProperties(target, props) {
        for (var i = 0; i < props.length; i++) {
            var descriptor = props[i];descriptor.enumerable = descriptor.enumerable || false;descriptor.configurable = true;if ("value" in descriptor) descriptor.writable = true;Object.defineProperty(target, descriptor.key, descriptor);
        }
    }return function (Constructor, protoProps, staticProps) {
        if (protoProps) defineProperties(Constructor.prototype, protoProps);if (staticProps) defineProperties(Constructor, staticProps);return Constructor;
    };
}();

function _classCallCheck(instance, Constructor) {
    if (!(instance instanceof Constructor)) {
        throw new TypeError("Cannot call a class as a function");
    }
}

var nextID = require('/makeup-next-id$0.0.1/index'/*'makeup-next-id'*/);
var exitEmitter = require('/makeup-exit-emitter$0.0.2/index'/*'makeup-exit-emitter'*/);
var focusables = require('/makeup-focusables$0.0.1/index'/*'makeup-focusables'*/);

var defaultOptions = {
    autoCollapse: true,
    click: false,
    contentSelector: '.expander__content',
    focus: false,
    focusManagement: null,
    hostSelector: '.expander__host',
    hover: false
};

function _onKeyDown() {
    this.keyDownFlag = true;
}

module.exports = function () {
    function _class(el, selectedOptions) {
        _classCallCheck(this, _class);

        this.options = _extends({}, defaultOptions, selectedOptions);

        this.el = el;
        this.hostEl = el.querySelector(this.options.hostSelector);
        this.expandeeEl = el.querySelector(this.options.contentSelector);

        // ensure the widget and expandee have an id
        nextID(this.el, 'expander');
        this.expandeeEl.id = this.el.id + '-content';

        exitEmitter.add(this.el);
        exitEmitter.add(this.expandeeEl);

        this._keyDownListener = _onKeyDown.bind(this);
        this._clickListener = this.toggle.bind(this);
        this._focusListener = this.expand.bind(this);
        this._hoverListener = this.expand.bind(this);

        this._exitListener = this.collapse.bind(this);
        this._expandeeExitListener = this.collapse.bind(this);
        this._leaveListener = this.collapse.bind(this);

        if (this.expandeeEl) {
            // the expander controls the expandee
            this.hostEl.setAttribute('aria-controls', this.expandeeEl.id);
            this.hostEl.setAttribute('aria-expanded', 'false');

            this.click = this.options.click;
            this.focus = this.options.focus;
            this.hover = this.options.hover;
        }
    }

    _createClass(_class, [{
        key: 'isExpanded',
        value: function isExpanded() {
            return this.hostEl.getAttribute('aria-expanded') === 'true';
        }
    }, {
        key: 'collapse',
        value: function collapse() {
            if (this.isExpanded() === true) {
                this.hostEl.setAttribute('aria-expanded', 'false');
                this.el.dispatchEvent(new CustomEvent('collapsed', { bubbles: true, detail: this.expandeeEl }));
            }
        }
    }, {
        key: 'expand',
        value: function expand(isKeyboard) {
            if (this.isExpanded() === false) {
                this.hostEl.setAttribute('aria-expanded', 'true');
                if (isKeyboard === true) {
                    var focusManagement = this.options.focusManagement;

                    if (focusManagement === 'content') {
                        this.expandeeEl.setAttribute('tabindex', '-1');
                        this.expandeeEl.focus();
                    } else if (focusManagement === 'focusable') {
                        focusables(this.expandeeEl)[0].focus();
                    } else if (focusManagement === 'interactive') {
                        focusables(this.expandeeEl, true)[0].focus();
                    } else if (focusManagement !== null) {
                        var el = this.expandeeEl.querySelector('#' + focusManagement);
                        if (el) {
                            el.focus();
                        }
                    }
                }
                this.el.dispatchEvent(new CustomEvent('expanded', { bubbles: true, detail: this.expandeeEl }));
            }
        }
    }, {
        key: 'toggle',
        value: function toggle() {
            if (this.isExpanded() === true) {
                this.collapse();
            } else {
                this.expand(this.keyDownFlag);
            }
            this.keyDownFlag = false;
        }
    }, {
        key: 'click',
        set: function set(bool) {
            if (bool === true) {
                this.hostEl.addEventListener('keydown', this._keyDownListener);
                this.hostEl.addEventListener('click', this._clickListener);
                if (this.options.autoCollapse === true) {
                    this.expandeeEl.addEventListener('focusExit', this._exitListener);
                }
            } else {
                this.hostEl.removeEventListener('keydown', this._keyDownListener);
                this.hostEl.removeEventListener('click', this._clickListener);
                if (this.options.autoCollapse === true) {
                    this.expandeeEl.removeEventListener('focusExit', this._exitListener);
                }
            }
        }
    }, {
        key: 'focus',
        set: function set(bool) {
            if (bool === true) {
                this.hostEl.addEventListener('focus', this._focusListener);
                if (this.options.autoCollapse === true) {
                    this.el.addEventListener('focusExit', this._expandeeExitListener);
                }
            } else {
                this.hostEl.removeEventListener('focus', this._focusListener);
                if (this.options.autoCollapse === true) {
                    this.el.removeEventListener('focusExit', this._expandeeExitListener);
                }
            }
        }
    }, {
        key: 'hover',
        set: function set(bool) {
            if (bool === true) {
                this.hostEl.addEventListener('mouseenter', this._hoverListener);
                if (this.options.autoCollapse === true) {
                    this.el.addEventListener('mouseleave', this._leaveListener);
                }
            } else {
                this.hostEl.removeEventListener('mouseenter', this._hoverListener);
                if (this.options.autoCollapse === true) {
                    this.el.removeEventListener('mouseleave', this._leaveListener);
                }
            }
        }
    }]);

    return _class;
}();
});
$_mod.def("/myebaynode$1.0.0/src/fe-components/m-show-diag/clipboard.min", function(require, exports, module, __filename, __dirname) { /*!
 * clipboard.js v1.7.1
 * https://zenorocha.github.io/clipboard.js
 *
 * Licensed MIT © Zeno Rocha
 */
!(function(t){if("object"==typeof exports&&"undefined"!=typeof module)module.exports=t();else if("function"==typeof define&&define.amd)define([],t);else{var e;e="undefined"!=typeof window?window:"undefined"!=typeof global?global:"undefined"!=typeof self?self:this,e.Clipboard=t()}}(function(){var t,e,n;return function t(e,n,o){function i(a,c){if(!n[a]){if(!e[a]){var l="function"==typeof require&&require;if(!c&&l)return l(a,!0);if(r)return r(a,!0);var s=new Error("Cannot find module '"+a+"'");throw s.code="MODULE_NOT_FOUND",s}var u=n[a]={exports:{}};e[a][0].call(u.exports,function(t){var n=e[a][1][t];return i(n||t)},u,u.exports,t,e,n,o)}return n[a].exports}for(var r="function"==typeof require&&require,a=0;a<o.length;a++)i(o[a]);return i}({1:[function(t,e,n){function o(t,e){for(;t&&t.nodeType!==i;){if("function"==typeof t.matches&&t.matches(e))return t;t=t.parentNode}}var i=9;if("undefined"!=typeof Element&&!Element.prototype.matches){var r=Element.prototype;r.matches=r.matchesSelector||r.mozMatchesSelector||r.msMatchesSelector||r.oMatchesSelector||r.webkitMatchesSelector}e.exports=o},{}],2:[function(t,e,n){function o(t,e,n,o,r){var a=i.apply(this,arguments);return t.addEventListener(n,a,r),{destroy:function(){t.removeEventListener(n,a,r)}}}function i(t,e,n,o){return function(n){n.delegateTarget=r(n.target,e),n.delegateTarget&&o.call(t,n)}}var r=t("./closest");e.exports=o},{"./closest":1}],3:[function(t,e,n){n.node=function(t){return void 0!==t&&t instanceof HTMLElement&&1===t.nodeType},n.nodeList=function(t){var e=Object.prototype.toString.call(t);return void 0!==t&&("[object NodeList]"===e||"[object HTMLCollection]"===e)&&"length"in t&&(0===t.length||n.node(t[0]))},n.string=function(t){return"string"==typeof t||t instanceof String},n.fn=function(t){return"[object Function]"===Object.prototype.toString.call(t)}},{}],4:[function(t,e,n){function o(t,e,n){if(!t&&!e&&!n)throw new Error("Missing required arguments");if(!c.string(e))throw new TypeError("Second argument must be a String");if(!c.fn(n))throw new TypeError("Third argument must be a Function");if(c.node(t))return i(t,e,n);if(c.nodeList(t))return r(t,e,n);if(c.string(t))return a(t,e,n);throw new TypeError("First argument must be a String, HTMLElement, HTMLCollection, or NodeList")}function i(t,e,n){return t.addEventListener(e,n),{destroy:function(){t.removeEventListener(e,n)}}}function r(t,e,n){return Array.prototype.forEach.call(t,function(t){t.addEventListener(e,n)}),{destroy:function(){Array.prototype.forEach.call(t,function(t){t.removeEventListener(e,n)})}}}function a(t,e,n){return l(document.body,t,e,n)}var c=t("./is"),l=t("delegate");e.exports=o},{"./is":3,delegate:2}],5:[function(t,e,n){function o(t){var e;if("SELECT"===t.nodeName)t.focus(),e=t.value;else if("INPUT"===t.nodeName||"TEXTAREA"===t.nodeName){var n=t.hasAttribute("readonly");n||t.setAttribute("readonly",""),t.select(),t.setSelectionRange(0,t.value.length),n||t.removeAttribute("readonly"),e=t.value}else{t.hasAttribute("contenteditable")&&t.focus();var o=window.getSelection(),i=document.createRange();i.selectNodeContents(t),o.removeAllRanges(),o.addRange(i),e=o.toString()}return e}e.exports=o},{}],6:[function(t,e,n){function o(){}o.prototype={on:function(t,e,n){var o=this.e||(this.e={});return(o[t]||(o[t]=[])).push({fn:e,ctx:n}),this},once:function(t,e,n){function o(){i.off(t,o),e.apply(n,arguments)}var i=this;return o._=e,this.on(t,o,n)},emit:function(t){var e=[].slice.call(arguments,1),n=((this.e||(this.e={}))[t]||[]).slice(),o=0,i=n.length;for(o;o<i;o++)n[o].fn.apply(n[o].ctx,e);return this},off:function(t,e){var n=this.e||(this.e={}),o=n[t],i=[];if(o&&e)for(var r=0,a=o.length;r<a;r++)o[r].fn!==e&&o[r].fn._!==e&&i.push(o[r]);return i.length?n[t]=i:delete n[t],this}},e.exports=o},{}],7:[function(e,n,o){!function(i,r){if("function"==typeof t&&t.amd)t(["module","select"],r);else if(void 0!==o)r(n,e("select"));else{var a={exports:{}};r(a,i.select),i.clipboardAction=a.exports}}(this,function(t,e){"use strict";function n(t){return t&&t.__esModule?t:{default:t}}function o(t,e){if(!(t instanceof e))throw new TypeError("Cannot call a class as a function")}var i=n(e),r="function"==typeof Symbol&&"symbol"==typeof Symbol.iterator?function(t){return typeof t}:function(t){return t&&"function"==typeof Symbol&&t.constructor===Symbol&&t!==Symbol.prototype?"symbol":typeof t},a=function(){function t(t,e){for(var n=0;n<e.length;n++){var o=e[n];o.enumerable=o.enumerable||!1,o.configurable=!0,"value"in o&&(o.writable=!0),Object.defineProperty(t,o.key,o)}}return function(e,n,o){return n&&t(e.prototype,n),o&&t(e,o),e}}(),c=function(){function t(e){o(this,t),this.resolveOptions(e),this.initSelection()}return a(t,[{key:"resolveOptions",value:function t(){var e=arguments.length>0&&void 0!==arguments[0]?arguments[0]:{};this.action=e.action,this.container=e.container,this.emitter=e.emitter,this.target=e.target,this.text=e.text,this.trigger=e.trigger,this.selectedText=""}},{key:"initSelection",value:function t(){this.text?this.selectFake():this.target&&this.selectTarget()}},{key:"selectFake",value:function t(){var e=this,n="rtl"==document.documentElement.getAttribute("dir");this.removeFake(),this.fakeHandlerCallback=function(){return e.removeFake()},this.fakeHandler=this.container.addEventListener("click",this.fakeHandlerCallback)||!0,this.fakeElem=document.createElement("textarea"),this.fakeElem.style.fontSize="12pt",this.fakeElem.style.border="0",this.fakeElem.style.padding="0",this.fakeElem.style.margin="0",this.fakeElem.style.position="absolute",this.fakeElem.style[n?"right":"left"]="-9999px";var o=window.pageYOffset||document.documentElement.scrollTop;this.fakeElem.style.top=o+"px",this.fakeElem.setAttribute("readonly",""),this.fakeElem.value=this.text,this.container.appendChild(this.fakeElem),this.selectedText=(0,i.default)(this.fakeElem),this.copyText()}},{key:"removeFake",value:function t(){this.fakeHandler&&(this.container.removeEventListener("click",this.fakeHandlerCallback),this.fakeHandler=null,this.fakeHandlerCallback=null),this.fakeElem&&(this.container.removeChild(this.fakeElem),this.fakeElem=null)}},{key:"selectTarget",value:function t(){this.selectedText=(0,i.default)(this.target),this.copyText()}},{key:"copyText",value:function t(){var e=void 0;try{e=document.execCommand(this.action)}catch(t){e=!1}this.handleResult(e)}},{key:"handleResult",value:function t(e){this.emitter.emit(e?"success":"error",{action:this.action,text:this.selectedText,trigger:this.trigger,clearSelection:this.clearSelection.bind(this)})}},{key:"clearSelection",value:function t(){this.trigger&&this.trigger.focus(),window.getSelection().removeAllRanges()}},{key:"destroy",value:function t(){this.removeFake()}},{key:"action",set:function t(){var e=arguments.length>0&&void 0!==arguments[0]?arguments[0]:"copy";if(this._action=e,"copy"!==this._action&&"cut"!==this._action)throw new Error('Invalid "action" value, use either "copy" or "cut"')},get:function t(){return this._action}},{key:"target",set:function t(e){if(void 0!==e){if(!e||"object"!==(void 0===e?"undefined":r(e))||1!==e.nodeType)throw new Error('Invalid "target" value, use a valid Element');if("copy"===this.action&&e.hasAttribute("disabled"))throw new Error('Invalid "target" attribute. Please use "readonly" instead of "disabled" attribute');if("cut"===this.action&&(e.hasAttribute("readonly")||e.hasAttribute("disabled")))throw new Error('Invalid "target" attribute. You can\'t cut text from elements with "readonly" or "disabled" attributes');this._target=e}},get:function t(){return this._target}}]),t}();t.exports=c})},{select:5}],8:[function(e,n,o){!function(i,r){if("function"==typeof t&&t.amd)t(["module","./clipboard-action","tiny-emitter","good-listener"],r);else if(void 0!==o)r(n,e("./clipboard-action"),e("tiny-emitter"),e("good-listener"));else{var a={exports:{}};r(a,i.clipboardAction,i.tinyEmitter,i.goodListener),i.clipboard=a.exports}}(this,function(t,e,n,o){"use strict";function i(t){return t&&t.__esModule?t:{default:t}}function r(t,e){if(!(t instanceof e))throw new TypeError("Cannot call a class as a function")}function a(t,e){if(!t)throw new ReferenceError("this hasn't been initialised - super() hasn't been called");return!e||"object"!=typeof e&&"function"!=typeof e?t:e}function c(t,e){if("function"!=typeof e&&null!==e)throw new TypeError("Super expression must either be null or a function, not "+typeof e);t.prototype=Object.create(e&&e.prototype,{constructor:{value:t,enumerable:!1,writable:!0,configurable:!0}}),e&&(Object.setPrototypeOf?Object.setPrototypeOf(t,e):t.__proto__=e)}function l(t,e){var n="data-clipboard-"+t;if(e.hasAttribute(n))return e.getAttribute(n)}var s=i(e),u=i(n),f=i(o),d="function"==typeof Symbol&&"symbol"==typeof Symbol.iterator?function(t){return typeof t}:function(t){return t&&"function"==typeof Symbol&&t.constructor===Symbol&&t!==Symbol.prototype?"symbol":typeof t},h=function(){function t(t,e){for(var n=0;n<e.length;n++){var o=e[n];o.enumerable=o.enumerable||!1,o.configurable=!0,"value"in o&&(o.writable=!0),Object.defineProperty(t,o.key,o)}}return function(e,n,o){return n&&t(e.prototype,n),o&&t(e,o),e}}(),p=function(t){function e(t,n){r(this,e);var o=a(this,(e.__proto__||Object.getPrototypeOf(e)).call(this));return o.resolveOptions(n),o.listenClick(t),o}return c(e,t),h(e,[{key:"resolveOptions",value:function t(){var e=arguments.length>0&&void 0!==arguments[0]?arguments[0]:{};this.action="function"==typeof e.action?e.action:this.defaultAction,this.target="function"==typeof e.target?e.target:this.defaultTarget,this.text="function"==typeof e.text?e.text:this.defaultText,this.container="object"===d(e.container)?e.container:document.body}},{key:"listenClick",value:function t(e){var n=this;this.listener=(0,f.default)(e,"click",function(t){return n.onClick(t)})}},{key:"onClick",value:function t(e){var n=e.delegateTarget||e.currentTarget;this.clipboardAction&&(this.clipboardAction=null),this.clipboardAction=new s.default({action:this.action(n),target:this.target(n),text:this.text(n),container:this.container,trigger:n,emitter:this})}},{key:"defaultAction",value:function t(e){return l("action",e)}},{key:"defaultTarget",value:function t(e){var n=l("target",e);if(n)return document.querySelector(n)}},{key:"defaultText",value:function t(e){return l("text",e)}},{key:"destroy",value:function t(){this.listener.destroy(),this.clipboardAction&&(this.clipboardAction.destroy(),this.clipboardAction=null)}}],[{key:"isSupported",value:function t(){var e=arguments.length>0&&void 0!==arguments[0]?arguments[0]:["copy","cut"],n="string"==typeof e?[e]:e,o=!!document.queryCommandSupported;return n.forEach(function(t){o=o&&!!document.queryCommandSupported(t)}),o}}]),e}(u.default);t.exports=p})},{"./clipboard-action":7,"good-listener":4,"tiny-emitter":6}]},{},[8])(8)}));

});
$_mod.def("/myebaynode$1.0.0/src/fe-components/m-show-diag/component", function(require, exports, module, __filename, __dirname) { const Expander = require('/makeup-expander$0.0.3/index'/*'makeup-expander'*/);
const Clipboard = require('/myebaynode$1.0.0/src/fe-components/m-show-diag/clipboard.min'/*'./clipboard.min'*/);

module.exports = {
    onMount() {
        this.getEl('mask').addEventListener('click', this.closeDialog.bind(this));

        const options = {
            autoCollapse: true,
            click: true,
            contentSelector: '.data-source__content',
            focus: false,
            focusManagement: 'focusable',
            hostSelector: '.data-source__title',
            hover: false
        };

        this.getEls('sources').forEach(source => {
            new Expander(source, options);
            new Clipboard(source.querySelector('.dialog__copy'));
        });
    },
    revealDialog() {
        const dialog = this.getEl('show-diag').querySelector('.dialog');
        dialog.classList.add('dialog--transition-in');

        setTimeout(() => {
            dialog.removeAttribute('hidden');
            dialog.classList.remove('dialog--transition-in');
        }, 16);
    },
    closeDialog() {
        const dialog = this.getEl('show-diag').querySelector('.dialog');
        dialog.classList.add('dialog--transition-out');
        dialog.addEventListener('transitionend', function handler(e) {
            e.currentTarget.removeEventListener(e.type, handler);
            dialog.setAttribute('hidden', true);
            dialog.classList.remove('dialog--transition-out');
        });
    }
};

});
$_mod.def("/myebaynode$1.0.0/src/fe-components/m-show-diag/index.marko", function(require, exports, module, __filename, __dirname) { // Compiled using marko@4.4.28 - DO NOT EDIT
"use strict";

var marko_template = module.exports = require('/marko$4.4.28/src/vdom'/*"marko/src/vdom"*/).t(),
    components_helpers = require('/marko$4.4.28/src/components/helpers-browser'/*"marko/src/components/helpers"*/),
    marko_registerComponent = components_helpers.rc,
    marko_componentType = marko_registerComponent("/myebaynode$1.0.0/src/fe-components/m-show-diag/index.marko", function() {
      return module.exports;
    }),
    marko_component = require('/myebaynode$1.0.0/src/fe-components/m-show-diag/component'/*"./component"*/),
    marko_renderer = components_helpers.r,
    marko_defineComponent = components_helpers.c,
    marko_helpers = require('/marko$4.4.28/src/runtime/vdom/helpers'/*"marko/src/runtime/vdom/helpers"*/),
    marko_forEach = marko_helpers.f,
    marko_attrs0 = {
        role: "dialog",
        "aria-labelledby": "dialog-title",
        hidden: true,
        "class": "dialog",
        id: "panel-left-slide"
      },
    marko_attrs1 = {
        role: "document",
        "class": "dialog__window dialog__window--left dialog__window--slide-right"
      },
    marko_attrs2 = {
        "class": "dialog__header"
      },
    marko_createElement = marko_helpers.e,
    marko_const = marko_helpers.const,
    marko_const_nextId = marko_const("5561ab"),
    marko_node0 = marko_createElement("H2", {
        "class": "dialog__title"
      }, 1, 0, {
        c: marko_const_nextId()
      })
      .t("Diagnostics"),
    marko_attrs3 = {
        type: "button",
        "class": "dialog__close"
      },
    marko_node1 = marko_createElement("svg", {
        focusable: "false"
      }, 1, 1, {
        c: marko_const_nextId()
      })
      .e("use", {
          "xlink:href": "#svg-icon-close"
        }, 0, 1),
    marko_attrs4 = {
        "class": "data-source__title"
      },
    marko_attrs5 = {
        "class": "data-source__content"
      },
    marko_node2 = marko_createElement("svg", {
        "aria-hidden": true,
        height: "14",
        width: "14",
        "class": "data-source__disclosure"
      }, 1, 1, {
        c: marko_const_nextId()
      })
      .e("use", {
          "xlink:href": "#svg-icon-chevron-down"
        }, 0, 1);

function render(input, out, __component, component, state) {
  var data = input;

  out.be("SPAN", {
      "class": "m-show-diag",
      id: __component.elId("show-diag")
    }, null, 4);

  out.e("BUTTON", {
      "class": "open-dialog",
      id: __component.elId("show-button")
    }, 1, 4, {
      onclick: __component.d("revealDialog")
    })
    .t("Open Diagnostics");

  out.be("DIV", marko_attrs0);

  out.be("DIV", marko_attrs1);

  out.e("HEADER", marko_attrs2, 2)
    .n(marko_node0)
    .e("BUTTON", marko_attrs3, 1, 0, {
        onclick: __component.d("closeDialog")
      })
      .n(marko_node1);

  out.be("DIV", {
      "class": "dialog__body",
      id: __component.elId("show-diag-content")
    }, null, 4);

  marko_forEach(Object.keys(data), function(dataSourceName) {
    const sourceData = JSON.stringify(data[dataSourceName], undefined, 4);

    out.e("DIV", {
        "class": "data-source",
        id: __component.elId("sources[]")
      }, 3, 4)
      .e("BUTTON", {
          type: "button",
          title: "copy JSON object",
          "data-clipboard-text": sourceData,
          "class": "dialog__copy"
        }, 1)
        .t("Copy JSON")
      .e("BUTTON", marko_attrs4, 2)
        .t(dataSourceName)
        .n(marko_node2)
      .e("DIV", marko_attrs5, 1)
        .e("PRE", null, 1)
          .t(sourceData);
  });

  out.ee();

  out.ee();

  out.e("DIV", {
      "class": "dialog__mask dialog__mask--fade-slow",
      id: __component.elId("mask")
    }, 0, 4);

  out.ee();

  out.ee();
}

marko_template._ = marko_renderer(render, {
    type: marko_componentType,
    roots: [
      "show-diag"
    ]
  }, marko_component);

marko_template.Component = marko_defineComponent(marko_component, marko_template._);

});