'use strict';
const render = require('../helpers/render');
const api = require('../helpers/api');

let actionHandler = {

  // Handler for enabling, disabling or toggling a Boolean preference. Currently
  // accepts one preference at a time, but should be easy to modify to handle
  // bulk operations if needed.
  modifyPreference(req, res, next) {
    let user = req.user;
    let preferenceName = req.body['preferenceName'].trim();
    let modifyAction = req.params['modify'];

    if (!user)
      return api.signinRequired(req, res);

    if (!user.getValidPreferences().includes(preferenceName))
      return api.error(req, res, 'Unknown preference: ' + preferenceName);

    let message;
    let oldValue = user[preferenceName] === undefined ? 'not set' : String(user[preferenceName]);
    switch (modifyAction) {
      case 'enable':
        user[preferenceName] = true;
        break;
      case 'disable':
        user[preferenceName] = false;
        break;
      case 'toggle':
        user[preferenceName] = !user[preferenceName];
        break;
      default:
        return api.error(req, res, 'Unknown preference action: ' + modifyAction);
    }
    let newValue = String(user[preferenceName]);
    message = oldValue === newValue ? `Preference not altered.` :
      `Preference changed.`;

    user
      .save()
      .then(() => {
        res.status(200);
        res.send(JSON.stringify({
          message,
          oldValue,
          newValue,
          errors: []
        }, null, 2));
      })
      .catch(next);
  },
  // Handler for hiding interface messages, announcements, etc., permanently for a given user
  suppressNotice(req, res, next) {

    let noticeType = req.body.noticeType.trim();
    let user = req.user;
    let output = req.isAPI ? api : render;
    if (!user)
      return output.signinRequired(req, res);

    switch (noticeType) {
      case 'language-notice-review':
      case 'language-notice-thing':
        if (!user.suppressedNotices)
          user.suppressedNotices = [noticeType];
        else
        if (user.suppressedNotices.indexOf(noticeType) == -1)
          user.suppressedNotices.push(noticeType);

        user
          .save()
          .then(() => {
            if (req.isAPI) {
              let response = {};
              response.message = `Success. Messages of type "${noticeType}" will no longer be shown.`;
              response.errors = [];
              res.type('json');
              res.status(200);
              res.send(JSON.stringify(response, null, 2));
            } else {
              render.template(req, res, 'notice-suppressed', {
                titleKey: 'notice suppressed',
                noticeMessage: req.__(`notice type ${noticeType}`)
              });
            }
          })
          .catch(next);
        break;

      default:
        if (req.isAPI) {
          let response = {};
          response.message = 'The request could not be processed.';
          response.errors = [`The given notice type, ${noticeType}, was not recognized.`];
          res.type('json');
          res.status(400);
          res.send(JSON.stringify(response, null, 2));
        } else {
          render.template(req, res, 'unsupported-notice', {
            titleKey: 'unsupported notice',
            noticeType
          });
        }
    }

  }

};
module.exports = actionHandler;
