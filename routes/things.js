'use strict';
const express = require('express');
const router = express.Router();
const escapeHTML = require('escape-html');
const thinky = require('../db');
const r = thinky.r;

const Thing = require('../models/thing');
const mlString = require('../models/helpers/ml-string');
const render = require('./helpers/render');
const flashError = require('./helpers/flash-error');
const getResourceErrorHandler = require('./handlers/resource-error-handler');

/* GET users listing. */
router.get('/thing/:id', function(req, res, next) {
  let id = req.params.id.trim();
  Thing.getNotStaleOrDeleted(id)
    .then(thing => {
      thing.populateUserInfo(req.user);
      sendThing(req, res, thing);
    })
    .catch(getResourceErrorHandler(req, res, next, 'thing', id));
});

router.get('/thing/:id/edit/label', function(req, res, next) {
  if (!req.user)
    return render.signinRequired(req, res, {
      titleKey: 'edit label'
    });

  let id = req.params.id.trim();
  Thing.getNotStaleOrDeleted(id)
    .then(thing => {
      thing.populateUserInfo(req.user);
      if (!thing.userCanEdit)
        return render.permissionError(req, res, {
          titleKey: 'edit label'
        });

      let edit = {
        label: true,
        titleKey: 'edit label'
      };
      sendThing(req, res, thing, edit);
    })
    .catch(getResourceErrorHandler(req, res, next, 'thing', id));
});

router.post('/thing/:id/edit/label', function(req, res, next) {
  let id = req.params.id.trim();
  Thing.getNotStaleOrDeleted(id)
    .then(thing => {

      thing.populateUserInfo(req.user);
      if (!thing.userCanEdit)
        return render.permissionError(req, res, {
          titleKey: 'edit label'
        });

      thing.newRevision(req.user).then(newRev => {
          if (!newRev.label)
            newRev.label = {};
          newRev.label[req.body['thing-label-language']] = escapeHTML(req.body['thing-label']);
          newRev.save().then(thing => {
              res.redirect(`/thing/${id}`);
            })
            .catch(error => {
              let errorMessage = Thing.resolveError(error);
              flashError(req, errorMessage, 'editing label - saving');
              sendThing(req, res, thing);
            });
        })
        .catch(error => {
          flashError(req, error, 'editing label - creating new revision');
          sendThing(req, res, thing);
        });
    })
    .catch(getResourceErrorHandler(req, res, next, 'thing', id));
});


function sendThing(req, res, thing, edit) {
  let pageErrors = req.flash('pageErrors');
  let showLanguageNotice = false;
  let user = req.user;

  // For convenient access to primary URL
  if (thing.urls && thing.urls.length) {
    thing.mainURL = thing.urls.shift();
    if (thing.urls.length)
      thing.otherURLs = thing.urls;
  }

  if (edit && req.method == 'GET' && (!user.suppressedNotices ||
    user.suppressedNotices.indexOf('language-notice-thing') == -1))
    showLanguageNotice = true;

  render.template(req, res, 'thing', {
    deferHeader: edit ? true : false,
    titleKey: edit ? edit.titleKey : undefined,
    thing,
    edit,
    pageErrors,
    showLanguageNotice
  });
}

module.exports = router;
