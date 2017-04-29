/* global $ */
/* eslint prefer-reflect: "off" */
'use strict';

// This file integrates the ProseMirror RTE for textareas that have the
// data-markdown attribute set. The switcher between the two modes is rendered
// server-side from the views/partial/editor-switcher-cher.hbs template.

// ProseMirror editor components
const { EditorState } = require('prosemirror-state');
const { EditorView } = require('prosemirror-view');
const { schema, defaultMarkdownParser, defaultMarkdownSerializer } = require('prosemirror-markdown');
const { keymap } = require('prosemirror-keymap');
const { baseKeymap } = require('prosemirror-commands');
const { menuBar } = require('prosemirror-menu');
// For indicating the drop target when dragging a text selection
const { dropCursor } = require('prosemirror-dropcursor');
const inputRules = require('prosemirror-inputrules');
const history = require('prosemirror-history');

// Custom keymap
const { getExtendedKeymap } = require('./editor-extended-keymap');

// Custom menu
const { buildMenuItems } = require('./editor-menu');

// For tracking contentEditable selection
const { saveSelection, restoreSelection } = require('./editor-selection');

const activeInputRules = [
  // Convert -- to —
  inputRules.emDash,
  // Convert ... to …
  inputRules.ellipsis,
  // Convert 1. , 2. .. at beginning of line to numbered list
  inputRules.orderedListRule(schema.nodes.ordered_list),
  // Convert * or - at beginning of line to bullet list
  inputRules.wrappingInputRule(/^\s*([-*]) $/, schema.nodes.bullet_list),
  // Convert > at beginning of line to quote
  inputRules.blockQuoteRule(schema.nodes.blockquote),
  // Convert #, ##, .. at beginning of line to heading
  inputRules.headingRule(schema.nodes.heading, 6)
];

// ProseMirror provides no native way to enable/disable the editor, so
// we add it here
EditorView.prototype.disable = function() {
  let editorElement = this.dom;
  $(editorElement)
    .removeAttr('contenteditable')
    .addClass('ProseMirror-disabled');
  $(editorElement)
    .prev('.ProseMirror-menubar')
    .addClass('ProseMirror-menubar-disabled');
};

EditorView.prototype.enable = function() {
  let editorElement = this.dom;
  $(editorElement)
    .attr('contenteditable', true)
    .removeClass('ProseMirror-disabled');
  $(editorElement)
    .prev('.ProseMirror-menubar')
    .removeClass('ProseMirror-menubar-disabled');
};

// We can have multiple RTEs on a page, and we keep generating new instances.
// The page-level counter keeps track of them. Access it only via its
// .current property.
const rteCounter = {
  _counter: 0,
  increase() {
    this._counter++;
  },
  get current() {
    return this._counter;
  },
  set current(c) {
    throw new Error('Counter should only be increase()d or accessed.');
  }
};

// Active view instances and associated information. Uses numbers as keys
// but not an array to ensure consistent access even if instances are removed.
let rtes = {};

// Export for access to other parts of the application, if available
if (window.libreviews)
  window.libreviews.activeRTEs = rtes;

// We keep track of the RTE's caret and scroll position, but only if the
// markdown representation hasn't been changed.
$('textarea[data-markdown]').change(function() {
  $(this)
    .removeAttr('data-rte-sel-start')
    .removeAttr('data-rte-sel-end')
    .removeAttr('data-rte-scroll-y');
});

// Switch to the RTE
$('[data-enable-rte]').click(function enableRTE() {
  if (!isSelectable(this, 'data-rte-enabled'))
    return false;

  let $textarea = $(this).parent().prev(),
    selStart = $textarea.attr('data-rte-sel-start'),
    selEnd = $textarea.attr('data-rte-sel-end'),
    scrollY = $textarea.attr('data-rte-scroll-y');

  $textarea.hide();

  // Do the heavy lifting of creating a new RTE instance
  let $rteContainer = renderRTE($textarea),
    $contentEditable = $rteContainer.find('[contenteditable="true"]'),
    editorID = $rteContainer[0].id.match(/\d+/)[0];

  if (selStart !== undefined && selEnd !== undefined)
    restoreSelection($contentEditable[0], { start: selStart, end: selEnd });

  if (scrollY !== undefined)
    $contentEditable.scrollTop(scrollY);

  rtes[editorID].editorView.focus();

});

// Switch back to markdown
$('[data-enable-markdown]').click(function enableMarkdown(event) {
  if (!isSelectable(this, 'data-markdown-enabled'))
    return false;

  let $rteContainer = $(this).parent().prev(),
    $textarea = $rteContainer.prev(),
    $contentEditable = $rteContainer.find('[contenteditable="true"]'),
    editorID = $rteContainer[0].id.match(/\d+/)[0];

  // .detail contains number of clicks. If 0, user likely got here via
  // accesskey, so the blur() event never fired.
  if (event.originalEvent.detail === 0) {
    updateRTESelectionData($textarea, $contentEditable);
    updateTextarea($textarea, $contentEditable, rtes[editorID].editorView);
  }

  // Delete the old RTE and all event handlers
  rtes[editorID].nuke();

  $textarea.show();
  if ($textarea[0].hasAttribute('data-reset-textarea')) {
    $textarea.removeAttr('data-reset-textarea');
    $textarea[0].setSelectionRange(0, 0);
  }
  $textarea.focus();
});

// Let users toggle preference for the RTE using a "sticky" pin next to the
// RTE control
$('.editor-switcher-pin').click(function() {
  let $pin = $(this);
  let spin = () => $pin
    .removeClass('fa-thumb-tack')
    .addClass('fa-spinner fa-spin editor-switcher-working');
  let unspin = () => $pin
    .removeClass('fa-spinner fa-spin editor-switcher-working')
    .addClass('fa-thumb-tack');

  let done = false;
  setTimeout(() => {
    if (!done) spin();
  }, 100);
  $.ajax({
      type: 'POST',
      url: `/api/actions/toggle-preference/`,
      data: JSON.stringify({
        preferenceName: 'prefersRichTextEditor'
      }),
      contentType: 'application/json',
      dataType: 'json'
    })
    .done(res => {
      done = true;
      unspin();
      let { newValue } = res;

      if (newValue === 'true')
        // Because we may have multiple editors on a page, all pins need to be restyled
        $('.editor-switcher-pin')
          .removeClass('editor-switcher-unpinned')
          .addClass('editor-switcher-pinned')
          .attr('title', window.config.messages['forget rte preference']);
      else
        $('.editor-switcher-pin')
          .removeClass('editor-switcher-pinned')
          .addClass('editor-switcher-unpinned')
          .attr('title', window.config.messages['remember rte preference']);
    })
    .fail(() => {
      done = true;
      unspin();
      $('#generic-action-error').removeClass('hidden');
    });
});

// Switch all RTEs on if this is the user's preference. The switcher controls
// are already rendered server-side to be in RTE state.
if (window.config.userPrefersRichTextEditor) {
  $('textarea[data-markdown]').each(function() {
    let $textarea = $(this);
    $textarea.hide();
    renderRTE($textarea);
  });
}

// Create a new RTE (ProseMirror) instance and add it to the DOM; register
// relevant event handlers. FIXME: Refactor me!
function renderRTE($textarea) {

  // Local copy for this instance; only access count if you want to increase
  let myID = rteCounter.current;

  let $rteContainer = $(`<div id="pm-edit-${myID}" class="rte-container"></div>`)
    .insertAfter($textarea);

  const menu = buildMenuItems(schema);
  const state = EditorState.create({
    doc: defaultMarkdownParser.parse($textarea.val()),
    plugins: [
      inputRules.inputRules({
        rules: activeInputRules
      }),
      keymap(getExtendedKeymap(schema, menu)),
      keymap(baseKeymap),
      history.history(),
      dropCursor(),
      menuBar({
        floating: false,
        content: menu.fullMenu
      })
    ]
  });

  let editorView = new EditorView($(`#pm-edit-${myID}`)[0], {
    state
  });

  rtes[myID] = { editorView };

  let $ce = $rteContainer.find('[contenteditable="true"]');

  // Adjust height to match textarea
  let setRTEHeight = () => {
    let textareaHeight = $textarea.css('height');
    if (textareaHeight)
      $rteContainer.css('height', textareaHeight);
    else
      $rteContainer.css('height', '10em');
    textareaHeight = parseInt($textarea.css('height'), 10);
    let menuHeight = parseInt($rteContainer.find('.ProseMirror-menubar').css('height'), 10) || 41;
    let rteHeight = textareaHeight - (menuHeight + 2);
    $ce.css('height', rteHeight + 'px');
  };
  setRTEHeight();

  // Menu can wrap, so keep an eye on the height
  $(window).resize(setRTEHeight);
  rtes[myID].resizeEventHandler = setRTEHeight;

  $ce.blur(function() {
    updateRTESelectionData($textarea, $(this));
    // Re-generating the markdown on blur is a performance compromise; we may want
    // to add more triggers if this is insufficient.
    updateTextarea($textarea, $(this), editorView);
  });

  $(window).on('beforeunload', function() {
    // Let's be nice to scripts that try to rescue form data
    updateTextarea($textarea, $ce, editorView);
  });

  // Full remove this control and all associated event handlers
  rtes[myID].nuke = function() {
    $ce.off();
    $(window).off('resize', rtes[myID].resizeEventHandler);
    rtes[myID].editorView.destroy();
    delete rtes[myID];
    $rteContainer.remove();
  };

  // Helper for external access to re-generate RTE
  rtes[myID].reRender = function() {
    rtes[myID].nuke();
    renderRTE($textarea);
  };

  // Style whole container (incl. menu bar etc.) like all inputs
  $ce.focus(function() {
    $rteContainer.addClass('rte-focused');
  });

  $ce.focusout(function() {
    $rteContainer.removeClass('rte-focused');
  });

  rteCounter.increase();
  return $rteContainer;
}

// Serialize RTE content into Markdown and update textarea
function updateTextarea($textarea, $ce, editorView) {
  let markdown = defaultMarkdownSerializer.serialize(editorView.state.doc);
  if (markdown !== $textarea.val()) {
    $textarea.val(markdown);
    $textarea
      .trigger('keyup')
      .trigger('change');
    // Make a note that cursor needs to be reset. This must happen after
    // the textarea's visibility is restored to work correctly in Firefox.
    $textarea.attr('data-reset-textarea', '');
  }
}

// We want to be able to preserve the user's place in the document unless
// they've changed it. To do so, we stash the current RTE selection in the
// textarea, since we create a new RTE instance every time the user switches
// between editing environments.
function updateRTESelectionData($textarea, $ce) {
  if (saveSelection) {
    let sel = saveSelection($ce[0]);
    let scrollY = $($ce[0]).scrollTop();
    if (typeof sel == 'object' && typeof sel.start == 'number' && typeof sel.end == 'number') {
      $textarea.attr('data-rte-sel-start', sel.start);
      $textarea.attr('data-rte-sel-end', sel.end);
    }
    $textarea.attr('data-rte-scroll-y', scrollY);
  }
}

// Toggle a switcher if it is selectable, return status
function isSelectable(optionElement, activeOptionAttr) {
  let $switcher = $(optionElement).parent();
  if ($switcher[0].hasAttribute(activeOptionAttr))
    return false;
  else {
    toggleSwitcher($switcher);
    return true;
  }
}

// Flip classes and data- attributes for the two modes (markdown, RTE)
function toggleSwitcher($switcher) {
  let activateOption, activateState, deactivateOption, deactivateState;
  let controlData = ['[data-enable-rte]', '[data-enable-markdown]', 'data-rte-enabled', 'data-markdown-enabled'];
  if ($switcher[0].hasAttribute('data-rte-enabled')) { // => switch to markdown
    [activateOption, deactivateOption, deactivateState, activateState] = controlData;
    addIndicator({
      $switcher,
      selector: '[data-enable-markdown]',
      addPin: false
    });
    removeIndicator({
      $switcher,
      selector: '[data-enable-rte]'
    });
  } else { // => switch to RTE
    [deactivateOption, activateOption, activateState, deactivateState] = controlData;
    removeIndicator({
      $switcher,
      selector: '[data-enable-markdown]',
      pinEnabled: false
    });
    addIndicator({
      $switcher,
      selector: '[data-enable-rte]',
      pinEnabled: true
    });
  }
  $switcher.removeAttr(deactivateState).attr(activateState, '');
  $switcher.find(activateOption).removeClass('editor-switcher-option-selected');
  $switcher.find(deactivateOption).addClass('editor-switcher-option-selected');
}

// Checkbox indicator for mode switcher
function addIndicator(spec) {
  let { pinEnabled, selector, $switcher } = spec;
  let $selectedIndicator = $('<span class="fa fa-fw fa-check-circle editor-switcher-selected-indicator">&nbsp;</span>');
  $switcher.find(selector).prepend($selectedIndicator);
  if (pinEnabled)
    $switcher.find('.editor-switcher-pin').removeClass('hidden');
}

function removeIndicator(spec) {
  let { pinEnabled, selector, $switcher } = spec;
  $switcher.find(selector + ' .editor-switcher-selected-indicator').remove();
  if (!pinEnabled)
    $switcher.find('.editor-switcher-pin').addClass('hidden');
}
