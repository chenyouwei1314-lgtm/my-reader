const rules = require('./webpack.rules');
const HtmlWebpackPlugin = require('html-webpack-plugin');

module.exports = {
  module: {
    rules,
  },
  entry: './src/renderer/app.js',
};