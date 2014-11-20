'use strict';

/**
 * @license
 * (c) 2014 Cluster Labs, Inc. https://cluster.co/
 * License: MIT
 */

var crypto = require('crypto');
var fs = require('fs');
var path = require('path');

var uglify = require('uglify-js');

var SkitModule = require('./loader/SkitModule');
var loader = require('./loader/loader');
var util = require('./util');
var scriptresource = require('./loader/scriptresource');


var TargetEnvironment = scriptresource.TargetEnvironment;


//
// OPTIMIZER
//


function staticFilename(filename, fileContent) {
  var parts = filename.split('.');
  var md5 = crypto.createHash('md5').update(fileContent).digest('hex');
  parts[0] += '-v' + md5.substring(0, 12);
  return parts.join('.');
}


function findAllRoutes(root) {
  var routes = [];
  root.children().forEach(function(child) {
    if (child instanceof SkitModule) {
      var resources = loader.loadResourcesForModule(child);
      var mainObject = resources.objectsByModulePath[child.modulePath];
      if (mainObject.__controller__) {
        routes.push(child.modulePath);
      }
    } else {
      routes = routes.concat(findAllRoutes(child));
    }
  });
  return routes;
}


function optimizeServer(server, optimizedPackagePath, aliasMapFilename) {
  // COMBINE MODULES FOR PUBLIC SERVING
  var STATIC_PREFIX = '/' + server.staticPrefix;

  var moduleToStaticAliasMap = {};
  var allScripts = [];
  var allStylesheets = [];

  var jsFilename = path.join(STATIC_PREFIX, 'js-combined.js');
  var cssFilename = path.join(STATIC_PREFIX, 'css-combined.css');

  var publicRoot = server.root().getChildWithName('public');
  var routeModulePaths = findAllRoutes(publicRoot);

  routeModulePaths.forEach(function(modulePath) {
    var controllerModule = server.root().findNodeWithPath(modulePath);
    var resources = loader.loadResourcesForModule(controllerModule);

    resources.cssResources.forEach(function(css) {
      if (css.modulePath in moduleToStaticAliasMap) {
        return;
      }
      moduleToStaticAliasMap[css.modulePath] = cssFilename;

      var body = css.bodyContentType().body;
      allStylesheets.push(body);
    });

    resources.scriptResources.forEach(function(script) {
      if (script.modulePath in moduleToStaticAliasMap) {
        return;
      }
      if (!script.includeInEnvironment(TargetEnvironment.BROWSER)) {
        return;
      }
      moduleToStaticAliasMap[script.modulePath] = jsFilename;

      var body = script.bodyContentType().body;
      allScripts.push(body);
    });
  });

  // VERSION, UPDATE AND COPY ALL STATIC FILES

  var resolvedPackagePath = server.packagePath;
  if (resolvedPackagePath.charAt(resolvedPackagePath.length - 1) == '/') {
    resolvedPackagePath = resolvedPackagePath.substring(0, resolvedPackagePath.length - 1);
  }

  var allFiles = loader.walkSync(resolvedPackagePath);

  var filenameToContent = {};
  var staticFiles = [];
  var staticBasenames = {};

  allFiles.forEach(function(filename) {
    var basename = path.basename(filename);
    if (basename.indexOf('.') == 0) {
      return;
    }

    var relativeFilename = filename.replace(server.packagePath, '');

    var content = fs.readFileSync(filename);
    var stringContent = content + '';
    if (stringContent.indexOf('\ufffd') == -1) {
      content = stringContent;
    }

    filenameToContent[relativeFilename] = content;
    if (relativeFilename.indexOf(STATIC_PREFIX) == 0) {
      staticFiles.push(relativeFilename);
      staticBasenames[path.basename(relativeFilename)] = true;
    }
  });

  // Shunt these right in here so they get versioned and written out,
  // without having to actually do that manually.
  staticFiles.push(jsFilename);
  filenameToContent[jsFilename] = allScripts.join('\n');
  staticBasenames[path.basename(jsFilename)] = true;
  staticFiles.push(cssFilename);
  staticBasenames[path.basename(cssFilename)] = true;
  filenameToContent[cssFilename] = allStylesheets.join('\n');
  filenameToContent[aliasMapFilename] = JSON.stringify(moduleToStaticAliasMap);

  var staticFilenamesIndex = {};
  staticFiles.forEach(function(filename) {
    var sfilename = staticFilename(filename, filenameToContent[filename]);
    // TODO(Taylor): Replace /__static__/ with https://foo/bar/.
    staticFilenamesIndex[filename] = sfilename;
  });

  var escapedBasenames = Object.keys(staticBasenames).map(function(basename) {
    return util.escapeRegex(basename);
  });
  var replaceContentRegex = new RegExp(
      "(['\"(])(/?(?:[\\w.-]+/)*(?:" + escapedBasenames.join('|') + "))(\\\\?['\")])", 'g');

  var relativeFilenames = Object.keys(filenameToContent);
  relativeFilenames.forEach(function(filename) {
    if (!/\.(js|css|html|json)$/i.test(filename)) {
      return;
    }

    var original = filenameToContent[filename];
    if (!original.replace) {
      // Buffer, probably binary object.
      return;
    }

    filenameToContent[filename] = original.replace(replaceContentRegex, function(_, quote1, match, quote2) {
      if (match.indexOf('/') != 0 && match.indexOf('://') == -1) {
        match = path.join(path.dirname(filename), match);
      }
      if (match in staticFilenamesIndex) {
        match = staticFilenamesIndex[match];
      }
      return quote1 + match + quote2;
    });
  });

  // WRITE ALL OPTIMIZED FILES TO DISK

  var optimizedPackagePath = path.resolve(optimizedPackagePath);
  loader.mkdirPSync(optimizedPackagePath);

  relativeFilenames.forEach(function(relativeFilename) {
    var destinationFilename = relativeFilename;
    if (relativeFilename in staticFilenamesIndex) {
      destinationFilename = staticFilenamesIndex[relativeFilename];
    }

    var absoluteFilename = path.join(optimizedPackagePath, destinationFilename);
    loader.mkdirPSync(path.dirname(absoluteFilename));

    var body = filenameToContent[relativeFilename];
    if (/\.js$/.test(relativeFilename) && relativeFilename.indexOf(STATIC_PREFIX) == 0) {
      console.log('minifying:', relativeFilename);
      body = uglify.minify(body, {fromString: true}).code;
    }

    fs.writeFileSync(absoluteFilename, body);
  });
}


module.exports = {
  optimizeServer: optimizeServer
};