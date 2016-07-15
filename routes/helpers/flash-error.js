'use strict';
const debug = require('../../util/debug');
module.exports = function flashErrorMessage(req, errorMessage, context) {
    if (errorMessage && errorMessage.constructor && errorMessage.constructor.name == 'ErrorMessage') {
      req.flash('errors', req.__.apply(this, errorMessage.toEscapedArray()));
    } else {
      // May be standard JS Error. We'll log the details for inspection.
      req.flash('errors', req.__('unknown error'));
      debug.error({
        context,
        req,
        error: errorMessage
      });
    }
};
