/**
 * The embeddable cover widget (E04-F03-S01), served as a classic script. It is plain JavaScript with no
 * dependencies: a custom element that draws in a shadow root so the host page cannot break it, builds all of its
 * markup from text nodes (nothing from the API is ever parsed as HTML), and uses the account's branding through
 * CSS variables. It reads one quote and changes its optional benefits; it cannot create or bind. Design: docs/adr/0015.
 * The source contains no backticks or template placeholders so that it can live in this string.
 */
export const WIDGET_SCRIPT = String.raw`(function () {
  'use strict';
  if (window.customElements && window.customElements.get('astra-cover-offer')) return;

  var CSS =
    ':host{display:block;font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#1a1a1a;--primary:#0b5cad;--on-primary:#ffffff}' +
    '*{box-sizing:border-box}' +
    '.card{border:1px solid #c9ced6;border-radius:12px;background:#fff;padding:20px;max-width:640px}' +
    '.head{display:flex;align-items:center;gap:12px;margin:0 0 4px}' +
    '.head img{max-height:32px;max-width:120px}' +
    'h2{font-size:1.25rem;line-height:1.3;margin:0}' +
    '.sub{color:#4a4a4a;margin:0 0 16px;font-size:.9375rem}' +
    'ul{list-style:none;margin:0;padding:0}' +
    'li{display:flex;justify-content:space-between;gap:12px;align-items:flex-start;padding:12px 0;border-top:1px solid #e3e6ea}' +
    'li:first-child{border-top:0}' +
    '.name{font-weight:600}' +
    '.detail{display:block;color:#4a4a4a;font-size:.875rem;font-weight:400}' +
    '.price{white-space:nowrap;font-variant-numeric:tabular-nums;text-align:right}' +
    'label{display:flex;gap:10px;align-items:flex-start;cursor:pointer;flex:1}' +
    'input[type=checkbox]{width:22px;height:22px;margin:2px 0 0;accent-color:var(--primary);flex:none}' +
    'input:disabled+span{color:#4a4a4a}' +
    '.total{display:flex;justify-content:space-between;align-items:baseline;border-top:2px solid #1a1a1a;margin-top:8px;padding-top:12px;font-size:1.125rem;font-weight:700}' +
    '.note{color:#4a4a4a;font-size:.875rem;margin:12px 0 0}' +
    '.warn{background:#fff4e5;border:1px solid #b25e00;color:#4d2900;border-radius:8px;padding:10px 12px;margin:0 0 12px}' +
    'button.link{background:none;border:0;padding:0;color:var(--primary);text-decoration:underline;font:inherit;cursor:pointer}' +
    'a:focus-visible,button:focus-visible,input:focus-visible{outline:3px solid var(--primary);outline-offset:2px}' +
    '.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}' +
    '@media (forced-colors:active){.card{border-color:CanvasText}}' +
    '@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}';

  function money(v) {
    var n = Number(v);
    return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function h(tag, attrs) {
    var el = document.createElement(tag);
    if (attrs) for (var k in attrs) if (Object.prototype.hasOwnProperty.call(attrs, k) && attrs[k] !== null && attrs[k] !== undefined) el.setAttribute(k, attrs[k]);
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      if (c === null || c === undefined || c === false) continue;
      el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return el;
  }

  function AstraCoverOffer() {
    return Reflect.construct(HTMLElement, [], AstraCoverOffer);
  }
  AstraCoverOffer.prototype = Object.create(HTMLElement.prototype, { constructor: { value: AstraCoverOffer } });
  Object.setPrototypeOf(AstraCoverOffer, HTMLElement);

  AstraCoverOffer.prototype.connectedCallback = function () {
    if (!this._root) this._root = this.attachShadow({ mode: 'open' });
    this._busy = false;
    this._draw(null, 'Loading your cover options');
    this._load();
  };

  AstraCoverOffer.prototype._call = function (method, path, body) {
    var api = (this.getAttribute('api') || '').replace(/\/$/, '');
    var init = { method: method, headers: { authorization: 'Bearer ' + this.getAttribute('token'), accept: 'application/json' } };
    if (body) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    return fetch(api + path, init).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (json) {
        if (!res.ok) throw new Error((json && (json.detail || json.title)) || 'Something went wrong. Please try again.');
        return json;
      });
    });
  };

  AstraCoverOffer.prototype._load = function () {
    var self = this;
    var quote = this.getAttribute('quote');
    return this._call('GET', '/v1/quotes/' + encodeURIComponent(quote) + '/offer').then(
      function (offer) {
        self._offer = offer;
        self._draw(offer, null);
        self.dispatchEvent(new CustomEvent('astra:offer', { detail: offer, bubbles: true, composed: true }));
      },
      function (err) { self._draw(null, err.message, true); },
    );
  };

  AstraCoverOffer.prototype._select = function (codes) {
    var self = this;
    this._busy = true;
    this._announce('Updating the price');
    return this._call('PUT', '/v1/quotes/' + encodeURIComponent(this.getAttribute('quote')) + '/selection', { selection: codes })
      .then(function () { return self._load(); })
      .then(function () {
        self._busy = false;
        self._announce('Price updated to ' + (self._offer && self._offer.total ? money(self._offer.total) : 'unavailable'));
        self.dispatchEvent(new CustomEvent('astra:selection', { detail: { quoteId: self._offer.quoteId, selection: codes, total: self._offer.total }, bubbles: true, composed: true }));
      })
      .catch(function (err) {
        self._busy = false;
        self._draw(self._offer, err.message, true);
      });
  };

  AstraCoverOffer.prototype._announce = function (text) {
    var live = this._root.querySelector('[data-live]');
    if (live) live.textContent = text;
  };

  AstraCoverOffer.prototype._wording = function (button) {
    var self = this;
    button.disabled = true;
    return fetch(this._offer.wordingUrl, { headers: { authorization: 'Bearer ' + this.getAttribute('token') } })
      .then(function (res) { if (!res.ok) throw new Error('The wording could not be opened.'); return res.blob(); })
      .then(function (blob) { window.open(URL.createObjectURL(blob), '_blank', 'noopener'); })
      .catch(function (err) { self._announce(err.message); })
      .then(function () { button.disabled = false; });
  };

  AstraCoverOffer.prototype._draw = function (offer, message, isError) {
    var self = this;
    var root = this._root;
    while (root.firstChild) root.removeChild(root.firstChild);
    root.appendChild(h('style', null, CSS));
    var brand = offer && offer.branding;
    if (brand) {
      this.style.setProperty('--primary', brand.primaryColor);
      this.style.setProperty('--on-primary', brand.textOnPrimary);
    }
    var card = h('section', { class: 'card', 'aria-labelledby': 'astra-title', 'aria-busy': offer ? 'false' : 'true' });
    var head = h('div', { class: 'head' });
    if (brand && brand.logoUrl) head.appendChild(h('img', { src: brand.logoUrl, alt: brand.displayName }));
    head.appendChild(h('h2', { id: 'astra-title' }, offer ? 'Cover for your trip' : 'Cover for your trip'));
    card.appendChild(head);
    card.appendChild(h('p', { class: 'sub' }, offer ? offer.plan.name + (brand ? ', offered by ' + brand.displayName : '') : ''));
    card.appendChild(h('div', { 'data-live': '', class: 'sr', role: 'status', 'aria-live': 'polite' }));
    if (message) card.appendChild(h('p', { class: isError ? 'warn' : 'note', role: isError ? 'alert' : null }, message));
    if (offer) {
      if (offer.status !== 'open') card.appendChild(h('p', { class: 'warn', role: 'alert' }, offer.status === 'bound' ? 'This cover has already been bought.' : 'This offer has expired. Please start again.'));
      else if (offer.outcome !== 'eligible') card.appendChild(h('p', { class: 'warn', role: 'alert' }, offer.notBindable.length ? offer.notBindable.join(' ') : 'Cover cannot be offered for this trip.'));
      var list = h('ul', { 'aria-label': 'Benefits' });
      offer.benefits.forEach(function (b) {
        var optional = b.packaging !== 'packaged';
        if (!optional && !b.selected) return;
        var detail = [b.limit ? 'Up to ' + b.limit : null, !b.available && b.reason ? b.reason : null].filter(Boolean).join('. ');
        var text = h('span', null, h('span', { class: 'name' }, b.name), detail ? h('span', { class: 'detail' }, detail) : null);
        var price = h('span', { class: 'price' }, b.selected ? (b.premium ? money(b.premium) : 'Included') : optional && b.available ? 'Add' : '');
        var row;
        if (optional) {
          var input = h('input', { type: 'checkbox' });
          input.checked = b.selected;
          input.disabled = self._busy || offer.status !== 'open' || (!b.available && !b.selected);
          input.addEventListener('change', function () {
            var chosen = offer.benefits.filter(function (x) { return x.packaging !== 'packaged' && x.selected && x.code !== b.code; }).map(function (x) { return x.code; });
            if (input.checked) chosen.push(b.code);
            self._select(chosen);
          });
          row = h('li', null, h('label', null, input, text), price);
        } else row = h('li', null, text, price);
        list.appendChild(row);
      });
      card.appendChild(list);
      card.appendChild(h('p', { class: 'total' }, h('span', null, 'Total premium'), h('span', { class: 'price' }, offer.total ? money(offer.total) : 'Not available')));
      if (offer.wordingUrl) {
        var link = h('button', { type: 'button', class: 'link' }, 'Read the full policy wording');
        link.addEventListener('click', function () { self._wording(link); });
        card.appendChild(h('p', { class: 'note' }, link, offer.disclosureTitle ? '. Required notice: ' + offer.disclosureTitle + '.' : '.'));
      }
    }
    root.appendChild(card);
  };

  AstraCoverOffer.observedAttributes = [];
  customElements.define('astra-cover-offer', AstraCoverOffer);
})();
`;
