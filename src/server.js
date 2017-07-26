import express from "express";
import serveFavicon from "serve-favicon";
import path from "path";
import cookieParser from "cookie-parser";
import compression from "compression";
import _ from "lodash";
import React from "react";
import ReactDOMServer from "react-dom/server";
import {
  StaticRouter as ServerRouter,
  Route as ServerRoute,
  Switch as ServerSwitch,
} from "react-router";

import createHistory from "history/createMemoryHistory";

import {
  extractFilesFromAssets,
  getModuleByUrl,
  getRouteFromPath
} from "core/utils/bundler";

import {
  getPreloadDataPromises,
  renderRoutesByUrl,
  renderNotFoundPage,
  renderErrorPage,
} from "core/utils/renderer";

import Storage from "core/libs/storage";
import Api from "core/libs/api";
import configureStore from "core/store";
import Routes  from "./routes";
import config from "./config";
import Html from "core/components/html";


// Create and express js application
const app = express.Router();

// use compression for all requests
app.use(compression());


let currentDir = __dirname;

if (process.env.NODE_ENV === "production") {
  const filename = _.find(process.argv, arg => {
    return arg.indexOf("/server.js") !== -1;
  });
  if (filename) {
    currentDir = path.dirname(filename);
  }
}
try {
  const faviconPath = path.join(currentDir, "public", "favicon.ico");
  // eslint-disable-next-line
  if (path.resolve(faviconPath)) {
    app.use(serveFavicon(faviconPath));
  }
} catch (ex) {
  // eslint-disable-next-line
  console.log("Please add favicon @ src/public/favicon.ico for improved performance.");
}

// Extract cookies from the request
app.use(cookieParser());

// Set x-powered-by to false (security issues)
_.set(app, "locals.settings.x-powered-by", false);

const getErrorComponent = (err, store) => {
  if (!(err instanceof Error)) {
    err = new Error(err);
  }
  err.statusCode = err.statusCode || 500;
  return renderErrorPage({
    render: false,
    Router: ServerRouter,
    Route: ServerRoute,
    Switch: ServerSwitch,
    error: err,
    store
  });
};

/**
 * Send global data to user, as we do not want to send it via
 * window object
 */
app.get("/_globals", (req, res) => {

  // Never ever cache this request
  const { assets } = req;
  const allCss = extractFilesFromAssets(assets, ".css");
  const allJs = extractFilesFromAssets(assets, ".js");

  res.setHeader("Content-Type", "application/json");
  // No cache header
  res.setHeader("Cache-Control", "private, no-cache, no-store, must-revalidate");
  res.setHeader("Expires", "-1");
  res.setHeader("Pragma", "no-cache");

  return res.send(JSON.stringify({routes: Routes, allCss, allJs}));
});

app.get("/manifest.json", (req, res) => {
  
  const { pwa } = config;
  
  const availableSizes = [72, 96, 128, 144, 152, 192, 384, 512];
  const icons = availableSizes.map(size => {
    return {
      "src": require(`resources/images/pwa/icon-${size}x${size}.png`),
      sizes: `${size}x${size}`
    };
  });
  _.set(pwa, "icons", icons);
  
  res.setHeader("Content-Type", "application/manifest+json");
  // No cache header
  res.setHeader("Cache-Control", "private, no-cache, no-store, must-revalidate");
  res.setHeader("Expires", "-1");
  res.setHeader("Pragma", "no-cache");
  
  return res.send(JSON.stringify(pwa));
});

app.get("*", (req, res) => {

  let routes = _.assignIn({}, Routes);

  // Get list of assets from request
  const {assets} = req;

  /**
   * Get all css and js files for mapping
   */
  const allCss = extractFilesFromAssets(assets, ".css");
  const allJs = extractFilesFromAssets(assets, ".js");

  let mod = getModuleByUrl(routes, req.path);
  const currentRoutes = getRouteFromPath(routes, req.path);
  const storage = new Storage(req, res);
  const api = new Api({storage});

  /**
   * Get css generated by current route and module
   */
  const currentRouteCss = _.filter(allCss, css => {
    const fileName = css.split("/").pop();
    return !(_.startsWith(fileName, "mod-") && fileName.indexOf(mod) === -1);
  });

  /**
   * Get all javascript but the modules
   */
  const currentRouteJs = _.filter(allJs, js => {
    const fileName = js.split("/").pop();
    return !_.startsWith(fileName, "mod-") && !_.startsWith(fileName, "service-worker.js");
  });

  const context = {
    storage,
    api,
    pathname: req.path,
  };

  let html, statusCode = 200;

  // Get seo details for the routes in an inherited manner
  // i.e. get seo details of parent when feasible
  let seoDetails = {};
  let routerComponent = null;

  const history = createHistory();
  // Create redux store
  let store = configureStore({
    history
  });

  try {
    // Also preload data required when asked
    let promises = getPreloadDataPromises({
      routes: currentRoutes,
      storage,
      api,
      store
    });

    Promise.all(promises).then(() => {

      // Once all data has been pre-loaded and processed
      _.each(currentRoutes, r => {
        seoDetails = _.defaults({}, _.get(r, "seo", {}), seoDetails);
      });

      if (!currentRoutes.length) {
        routerComponent = renderNotFoundPage({
          render: false,
          Router: ServerRouter,
          url: req.path,
          Switch: ServerSwitch,
          Route: ServerRoute,
          context: context,
          history,
          store,
        });
      } else {
        routerComponent = renderRoutesByUrl({
          render: false,
          Router: ServerRouter,
          url: req.path,
          Switch: ServerSwitch,
          Route: ServerRoute,
          context: context,
          routes: currentRoutes,
          storage,
          store,
          api,
          history
        });
      }

      statusCode = context.status || 200;
      if (context.url) {
        // Somewhere a `<Redirect>` was rendered
        return res.status(statusCode).redirect(context.url);
      }

      html = ReactDOMServer.renderToStaticMarkup((
        <Html
          stylesheets={currentRouteCss}
          scripts={currentRouteJs}
          seo={seoDetails}
        >
          {routerComponent}
        </Html>
      ));
      return res.status(statusCode).send(`<!DOCTYPE html>${html}`);

    }).catch((err) => {
      routerComponent = getErrorComponent(err, store);
      html = ReactDOMServer.renderToStaticMarkup((
        <Html
          stylesheets={currentRouteCss}
          scripts={currentRouteJs}
        >
          {routerComponent}
        </Html>
      ));
      return res.status(statusCode).send(`<!DOCTYPE html>${html}`);
    });
    // Get data to load for all the routes
  } catch (err) {
    routerComponent = getErrorComponent(err, store);
    html = ReactDOMServer.renderToStaticMarkup((
      <Html
        stylesheets={currentRouteCss}
        scripts={currentRouteJs}
      >
        {routerComponent}
      </Html>
    ));
    return res.status(statusCode).send(`<!DOCTYPE html>${html}`);
  }
});

module.exports = app;
