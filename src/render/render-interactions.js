import { INTERACTIONS_NAV_JS } from "./render-interactions-nav.js";

export const INTERACTIONS_JS = `
  function attachExpandToggles() {
    var standalone = app.querySelectorAll('.chapter-output, .chapter-agent-prompt, .chapter-thinking-block, .chapter-mcp-output');
    standalone.forEach(function(block) {
      if (block.scrollHeight <= block.clientHeight + 2) return;
      if (block.nextElementSibling && block.nextElementSibling.classList.contains('expand-toggle')) return;
      var toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'expand-toggle';
      toggle.textContent = '\\u25b8 show more';
      toggle.setAttribute('aria-expanded', 'false');
      toggle.setAttribute('aria-label', 'Expand truncated content');
      toggle.addEventListener('click', function(ev) {
        ev.stopPropagation();
        if (block.classList.contains('expanded')) {
          block.classList.remove('expanded');
          toggle.textContent = '\\u25b8 show more';
          toggle.setAttribute('aria-expanded', 'false');
          toggle.setAttribute('aria-label', 'Expand truncated content');
        } else {
          block.classList.add('expanded');
          toggle.textContent = '\\u25be show less';
          toggle.setAttribute('aria-expanded', 'true');
          toggle.setAttribute('aria-label', 'Collapse truncated content');
        }
      });
      block.parentNode.insertBefore(toggle, block.nextSibling);
    });

    var diffBlocks = app.querySelectorAll('.chapter-diff-block');
    diffBlocks.forEach(function(diffBlock) {
      var children = diffBlock.querySelectorAll('.chapter-diff-del, .chapter-diff-add');
      var anyTruncated = false;
      children.forEach(function(child) {
        if (child.scrollHeight > child.clientHeight + 2) anyTruncated = true;
      });
      if (!anyTruncated) return;
      if (diffBlock.nextElementSibling && diffBlock.nextElementSibling.classList.contains('expand-toggle')) return;
      var toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'expand-toggle in-diff';
      toggle.textContent = '\\u25b8 show more';
      toggle.setAttribute('aria-expanded', 'false');
      toggle.setAttribute('aria-label', 'Expand truncated diff');
      toggle.addEventListener('click', function(ev) {
        ev.stopPropagation();
        var isExpanded = children[0] && children[0].classList.contains('expanded');
        children.forEach(function(child) {
          if (isExpanded) child.classList.remove('expanded');
          else child.classList.add('expanded');
        });
        if (isExpanded) {
          toggle.textContent = '\\u25b8 show more';
          toggle.setAttribute('aria-expanded', 'false');
          toggle.setAttribute('aria-label', 'Expand truncated diff');
        } else {
          toggle.textContent = '\\u25be show less';
          toggle.setAttribute('aria-expanded', 'true');
          toggle.setAttribute('aria-label', 'Collapse truncated diff');
        }
      });
      diffBlock.parentNode.insertBefore(toggle, diffBlock.nextSibling);
    });
  }
` + INTERACTIONS_NAV_JS;
