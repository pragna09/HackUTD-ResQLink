// Lets the app import the shared, dependency-free mesh logic from ../../module/src (mesh.ts),
// so phones, the dashboard simulator and the SpacetimeDB module all run the same routing code.
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
config.watchFolders = [...(config.watchFolders ?? []), path.resolve(__dirname, '../../module/src')];
module.exports = config;
