const VERSION = '0.2.2';

console.info(
  `%c STATISTICS-TABLE-CARD %c v${VERSION} `,
  'color: white; background: #1976d2; font-weight: bold; padding: 2px 4px;',
  'color: #1976d2; background: white; font-weight: bold; padding: 2px 4px;'
);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const SUPPORTED_FUNCTIONS = ['abs', 'min', 'max'];

class StatisticsTableCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._year = new Date().getFullYear();
    this._hass = null;
    this._config = null;
    this._loading = false;
    this._error = null;
    this._data = null;
  }

  disconnectedCallback() {
    if (this._closeExportMenu) {
      document.removeEventListener('click', this._closeExportMenu);
      this._closeExportMenu = null;
    }
  }

  set hass(hass) {
    const firstSet = !this._hass;
    this._hass = hass;
    if (firstSet && this._config) {
      this._fetchAndRender();
    }
  }

  setConfig(config) {
    if (!config.entities || !Array.isArray(config.entities) || config.entities.length === 0) {
      throw new Error('statistics-table-card: entities array is required');
    }
    const normalizedEntities = config.entities.map((entry, index) => this._normalizeEntity(entry, index));
    normalizedEntities.forEach((entity) => {
      if (entity.type !== 'derived') return;
      entity.formulaAst = this._parseFormula(entity.formula);
      this._bindFormulaReferences(entity.formulaAst, normalizedEntities);
    });
    this._validateDerivedGraph(normalizedEntities);
    this._config = {
      title: config.title || 'Monthly Statistics',
      hide_empty: config.hide_empty ?? false,
      entities: normalizedEntities,
    };
    if (config.year !== undefined) {
      const parsedYear = Number.parseInt(config.year, 10);
      if (!Number.isNaN(parsedYear)) {
        this._year = parsedYear;
      }
    }
    if (this._hass) {
      this._fetchAndRender();
    }
  }

  _normalizeEntity(entry, index) {
    if (typeof entry === 'string') {
      return {
        type: 'entity',
        id: entry,
        entity: entry,
        name: entry,
        unit: '',
        decimals: 1,
        yoy: false,
        mom: false,
        invert_delta: false,
      };
    }

    const isDerived = entry.type === 'derived' || !!entry.formula;
    const entity = {
      unit: '',
      decimals: 1,
      yoy: false,
      mom: false,
      invert_delta: false,
      ...entry,
    };

    if (entity.yoy === true) entity.yoy = 'percent';
    if (entity.mom === true) entity.mom = 'percent';

    if (isDerived) {
      if (!entity.formula || typeof entity.formula !== 'string') {
        throw new Error('statistics-table-card: derived columns require a formula string');
      }
      return {
        ...entity,
        type: 'derived',
        id: entity.id || `derived_${index}`,
        name: entity.name || entity.id || `Derived ${index + 1}`,
      };
    }

    if (!entity.entity) {
      throw new Error('statistics-table-card: entity is required for non-derived columns');
    }

    return {
      ...entity,
      type: 'entity',
      id: entity.id || entity.entity,
      name: entity.name || entity.entity,
    };
  }

  async _fetchAndRender() {
    if (!this._hass || !this._config) return;

    this._loading = true;
    this._error = null;
    this._update();

    try {
      const needsYoy = this._config.entities.some(e => e.yoy);
      const startTime = new Date(needsYoy ? this._year - 1 : this._year, 0, 1).toISOString();
      const endTime = new Date(this._year + 1, 0, 1).toISOString();
      const statIds = this._config.entities
        .filter(e => e.type === 'entity')
        .map(e => e.entity);

      this._data = await this._hass.callWS({
        type: 'recorder/statistics_during_period',
        start_time: startTime,
        end_time: endTime,
        period: 'month',
        statistic_ids: statIds,
        types: ['change'],
      });
    } catch (err) {
      this._error = err.message || 'Failed to fetch statistics';
    }

    this._loading = false;
    this._update();
  }

  _resolveSourceIndex(ref, entities) {
    const sourceIndex = entities.findIndex(entity => entity.id === ref || entity.entity === ref);
    if (sourceIndex === -1) {
      throw new Error(`statistics-table-card: unknown source "${ref}"`);
    }
    return sourceIndex;
  }

  _tokenizeFormula(formula) {
    const tokens = [];
    let index = 0;

    while (index < formula.length) {
      const char = formula[index];

      if (/\s/.test(char)) {
        index++;
        continue;
      }

      if ('+-*/(),'.includes(char)) {
        tokens.push({ type: char, value: char });
        index++;
        continue;
      }

      if (/\d/.test(char) || (char === '.' && /\d/.test(formula[index + 1] || ''))) {
        let end = index + 1;
        while (end < formula.length && /[\d.]/.test(formula[end])) end++;
        const value = Number(formula.slice(index, end));
        if (Number.isNaN(value)) {
          throw new Error(`statistics-table-card: invalid number in formula "${formula}"`);
        }
        tokens.push({ type: 'number', value });
        index = end;
        continue;
      }

      if (/[A-Za-z_]/.test(char)) {
        let end = index + 1;
        while (end < formula.length && /[A-Za-z0-9_.:-]/.test(formula[end])) end++;
        tokens.push({ type: 'identifier', value: formula.slice(index, end) });
        index = end;
        continue;
      }

      throw new Error(`statistics-table-card: invalid token "${char}" in formula "${formula}"`);
    }

    return tokens;
  }

  _parseFormula(formula) {
    const tokens = this._tokenizeFormula(formula);
    let position = 0;

    const peek = () => tokens[position];
    const consume = (type) => {
      const token = tokens[position];
      if (!token || token.type !== type) {
        throw new Error(`statistics-table-card: expected "${type}" in formula "${formula}"`);
      }
      position++;
      return token;
    };

    const parsePrimary = () => {
      const token = peek();
      if (!token) {
        throw new Error(`statistics-table-card: unexpected end of formula "${formula}"`);
      }

      if (token.type === 'number') {
        position++;
        return { type: 'number', value: token.value };
      }

      if (token.type === 'identifier') {
        position++;
        if (peek() && peek().type === '(') {
          const functionName = token.value;
          if (!SUPPORTED_FUNCTIONS.includes(functionName)) {
            throw new Error(`statistics-table-card: unsupported function "${functionName}"`);
          }
          consume('(');
          const args = [];
          if (peek() && peek().type !== ')') {
            while (true) {
              args.push(parseExpression());
              if (!peek() || peek().type !== ',') break;
              consume(',');
            }
          }
          consume(')');
          return { type: 'function', name: functionName, args };
        }
        return { type: 'ref', ref: token.value };
      }

      if (token.type === '(') {
        consume('(');
        const expression = parseExpression();
        consume(')');
        return expression;
      }

      if (token.type === '+' || token.type === '-') {
        position++;
        return { type: 'unary', op: token.type, arg: parsePrimary() };
      }

      throw new Error(`statistics-table-card: unexpected token "${token.value}" in formula "${formula}"`);
    };

    const parseMultiplicative = () => {
      let node = parsePrimary();
      while (peek() && (peek().type === '*' || peek().type === '/')) {
        const op = consume(peek().type).type;
        node = { type: 'binary', op, left: node, right: parsePrimary() };
      }
      return node;
    };

    const parseExpression = () => {
      let node = parseMultiplicative();
      while (peek() && (peek().type === '+' || peek().type === '-')) {
        const op = consume(peek().type).type;
        node = { type: 'binary', op, left: node, right: parseMultiplicative() };
      }
      return node;
    };

    const ast = parseExpression();
    if (position !== tokens.length) {
      throw new Error(`statistics-table-card: unexpected token "${tokens[position].value}" in formula "${formula}"`);
    }
    return ast;
  }

  _bindFormulaReferences(node, entities) {
    if (node.type === 'ref') {
      node.index = this._resolveSourceIndex(node.ref, entities);
      return;
    }

    if (node.type === 'binary') {
      this._bindFormulaReferences(node.left, entities);
      this._bindFormulaReferences(node.right, entities);
      return;
    }

    if (node.type === 'unary') {
      this._bindFormulaReferences(node.arg, entities);
      return;
    }

    if (node.type === 'function') {
      node.args.forEach((arg) => this._bindFormulaReferences(arg, entities));
    }
  }

  _evalFormulaNode(node, entities, values, visiting) {
    if (node.type === 'number') return node.value;

    if (node.type === 'ref') {
      return this._resolveEntityValue(entities, node.index, values, visiting);
    }

    if (node.type === 'unary') {
      const value = this._evalFormulaNode(node.arg, entities, values, visiting);
      if (value === null || value === undefined || isNaN(value)) return null;
      return node.op === '-' ? -value : value;
    }

    if (node.type === 'binary') {
      const left = this._evalFormulaNode(node.left, entities, values, visiting);
      const right = this._evalFormulaNode(node.right, entities, values, visiting);
      if (left === null || left === undefined || isNaN(left) || right === null || right === undefined || isNaN(right)) {
        return null;
      }
      if (node.op === '+') return left + right;
      if (node.op === '-') return left - right;
      if (node.op === '*') return left * right;
      if (node.op === '/') return right === 0 ? null : left / right;
    }

    if (node.type === 'function') {
      const args = node.args.map((arg) => this._evalFormulaNode(arg, entities, values, visiting));
      if (args.some((value) => value === null || value === undefined || isNaN(value))) return null;
      if (node.name === 'abs') return args.length === 1 ? Math.abs(args[0]) : null;
      if (node.name === 'min') return args.length > 0 ? Math.min(...args) : null;
      if (node.name === 'max') return args.length > 0 ? Math.max(...args) : null;
    }

    return null;
  }

  _resolveEntityValue(entities, entityIndex, values, visiting = new Set()) {
    const currentValue = values[entityIndex];
    if (currentValue !== undefined) return currentValue;

    const entity = entities[entityIndex];
    if (entity.type !== 'derived') return currentValue;

    if (visiting.has(entityIndex)) {
      throw new Error(`statistics-table-card: circular dependency involving "${entity.id}"`);
    }

    visiting.add(entityIndex);
    const computed = this._evalFormulaNode(entity.formulaAst, entities, values, visiting);
    values[entityIndex] = computed;
    visiting.delete(entityIndex);
    return computed;
  }

  _validateDerivedGraph(entities) {
    entities.forEach((entity, index) => {
      if (entity.type !== 'derived') return;
      this._resolveEntityValue(entities, index, new Array(entities.length));
    });
  }

  _buildRows() {
    const { entities } = this._config;
    const needsYoy = entities.some(e => e.yoy);

    const rows = Array.from({ length: 12 }, (_, m) => ({
      monthIndex: m,
      label: MONTHS[m],
      values: new Array(entities.length).fill(undefined),
      prev: needsYoy ? new Array(entities.length).fill(undefined) : null,
    }));

    entities.forEach((e, colIdx) => {
      if (e.type !== 'entity') return;
      const points = this._data[e.entity] || [];
      points.forEach(point => {
        const date = new Date(point.start);
        const year = date.getFullYear();
        const month = date.getMonth();
        if (month < 0 || month > 11) return;
        if (year === this._year) {
          rows[month].values[colIdx] = point.change ?? null;
        } else if (needsYoy && year === this._year - 1) {
          rows[month].prev[colIdx] = point.change ?? null;
        }
      });
    });

    rows.forEach((row) => {
      entities.forEach((entity, colIdx) => {
        if (entity.type !== 'derived') return;
        row.values[colIdx] = this._resolveEntityValue(entities, colIdx, row.values);
        if (row.prev) {
          row.prev[colIdx] = this._resolveEntityValue(entities, colIdx, row.prev);
        }
      });
    });

    return rows;
  }

  _deltaHtml(current, prev, entity, mode) {
    if (!mode || current === null || isNaN(current) || prev === null || isNaN(prev)) return '';
    const delta = current - prev;
    const sign = delta >= 0 ? '+' : '';
    const arrow = delta > 0 ? '▲' : delta < 0 ? '▼' : '▸';
    const positive = entity.invert_delta ? delta < 0 : delta > 0;
    const negative = entity.invert_delta ? delta > 0 : delta < 0;
    const cls = positive ? 'yoy-up' : negative ? 'yoy-dn' : 'yoy-flat';
    const rawDelta = `${sign}${delta.toFixed(entity.decimals)}`;
    const pctDelta = prev === 0 ? null : `${sign}${(delta / Math.abs(prev) * 100).toFixed(1)}%`;

    let text = `${arrow} ${rawDelta}`;
    if (mode === 'both') {
      if (pctDelta !== null) text = `${text} (${pctDelta})`;
    } else if (mode !== 'raw') {
      if (pctDelta === null) return `<div class="yoy yoy-flat">▸ n/a</div>`;
      text = `${arrow} ${pctDelta}`;
    }
    return `<div class="yoy ${cls}">${text}</div>`;
  }

  _yoyHtml(current, prev, entity) {
    return this._deltaHtml(current, prev, entity, entity.yoy);
  }

  _fmt(value, decimals) {
    if (value === null || value === undefined || isNaN(value)) return '—';
    return value.toFixed(decimals);
  }

  _buildTotals(rows, entities, key) {
    const totals = new Array(entities.length);

    entities.forEach((entity, index) => {
      if (entity.type === 'entity') {
        const hasValue = rows.some((row) => row[key][index] !== null && !isNaN(row[key][index]));
        totals[index] = hasValue
          ? rows.reduce((sum, row) => sum + (row[key][index] ?? 0), 0)
          : null;
      }
    });

    entities.forEach((entity, index) => {
      if (entity.type !== 'derived') return;
      totals[index] = this._resolveEntityValue(entities, index, totals);
    });

    return totals;
  }

  _update() {
    const root = this.shadowRoot;

    if (this._loading) {
      root.innerHTML = `
        <style>
          :host { display: block; }
          .loading {
            padding: 40px 16px;
            text-align: center;
            color: var(--secondary-text-color);
            font-size: 13px;
            letter-spacing: 0.3px;
            opacity: 0.7;
          }
        </style>
        <ha-card><div class="loading">Loading…</div></ha-card>
      `;
      return;
    }

    if (this._error) {
      root.innerHTML = `
        <style>
          :host { display: block; }
          .error {
            padding: 16px;
            color: var(--error-color);
            font-size: 13px;
            display: flex;
            align-items: center;
            gap: 8px;
          }
        </style>
        <ha-card><div class="error">&#9888; ${this._error}</div></ha-card>
      `;
      return;
    }

    const { entities, title, hide_empty } = this._config;
    const allRows = this._buildRows();
    const rows = hide_empty
      ? allRows.filter(row => row.values.some(v => v !== null && !isNaN(v)))
      : allRows;
    const currentYear = new Date().getFullYear();

    const totals = this._buildTotals(rows, entities, 'values');
    const prevTotals = allRows.length > 0 && allRows[0].prev
      ? this._buildTotals(rows, entities, 'prev')
      : null;

    const currentMonth = new Date().getMonth();
    const isCurrentYear = this._year === currentYear;

    root.innerHTML = `
      <style>
        :host { display: block; }
        ha-card { overflow: hidden; }

        .card-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 14px 16px 10px;
          font-size: 15px;
          font-weight: 600;
          color: var(--primary-text-color);
          letter-spacing: 0.2px;
        }

        .year-nav {
          display: flex;
          align-items: center;
          gap: 0;
          background: var(--secondary-background-color, rgba(255,255,255,0.06));
          border-radius: 20px;
          padding: 2px;
        }
        .year-nav button {
          background: none;
          border: none;
          cursor: pointer;
          color: var(--primary-text-color);
          width: 28px;
          height: 28px;
          border-radius: 50%;
          font-size: 18px;
          line-height: 1;
          display: flex;
          align-items: center;
          justify-content: center;
          opacity: 0.55;
          transition: opacity 0.15s, background 0.15s;
        }
        .year-nav button:hover:not([disabled]) {
          opacity: 1;
          background: var(--divider-color, rgba(255,255,255,0.12));
        }
        .year-nav button[disabled] { opacity: 0.2; cursor: default; }
        .year-label {
          min-width: 44px;
          text-align: center;
          font-weight: 700;
          font-size: 14px;
          color: var(--primary-text-color);
          letter-spacing: 0.5px;
        }

        .table-wrap {
          position: relative;
        }
        .table-scroll {
          overflow-x: auto;
          -webkit-overflow-scrolling: touch;
        }
        .table-scroll::-webkit-scrollbar { height: 4px; }
        .table-scroll::-webkit-scrollbar-track { background: transparent; }
        .table-scroll::-webkit-scrollbar-thumb {
          background: var(--divider-color, rgba(255,255,255,0.15));
          border-radius: 2px;
        }

        table {
          border-collapse: collapse;
          font-size: 13px;
          width: max-content;
          min-width: 100%;
        }
        thead tr {
          border-bottom: 1px solid var(--divider-color);
        }
        th {
          padding: 6px 12px 8px;
          text-align: right;
          color: var(--secondary-text-color);
          font-size: 10.5px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.7px;
          white-space: nowrap;
        }
        th:first-child {
          text-align: left;
          padding-left: 16px;
          position: sticky;
          left: 0;
          z-index: 2;
          background: var(--card-background-color, #1c1c1c);
        }
        th:last-child { padding-right: 16px; }

        tbody tr {
          transition: background 0.12s;
          border-bottom: 1px solid var(--divider-color);
        }
        tbody tr:nth-child(even) { background: var(--secondary-background-color, rgba(255,255,255,0.04)); }
        tbody tr:last-child { border-bottom: none; }
        tbody tr:hover { background: var(--table-row-color, rgba(255,255,255,0.08)); }

        tbody tr.current-month {
          background: rgba(var(--rgb-primary-color, 25, 118, 210), 0.10);
        }
        tbody tr.current-month td:first-child {
          color: var(--primary-color, #1976d2) !important;
          font-weight: 700;
        }

        td {
          padding: 7px 12px;
          text-align: right;
          color: var(--primary-text-color);
          white-space: nowrap;
          font-variant-numeric: tabular-nums;
        }
        td:first-child {
          text-align: left;
          padding-left: 16px;
          color: var(--secondary-text-color);
          font-size: 12.5px;
          font-weight: 500;
          position: sticky;
          left: 0;
          z-index: 1;
          background: var(--card-background-color, #1c1c1c);
        }
        tbody tr:nth-child(even) td:first-child {
          background: var(--secondary-background-color, rgba(255,255,255,0.04));
        }
        tbody tr.current-month td:first-child {
          background: transparent;
        }
        td:last-child { padding-right: 16px; }

        td.has-value {
          color: var(--primary-text-color);
          font-weight: 500;
        }
        td.no-value {
          color: var(--disabled-text-color, var(--secondary-text-color));
          opacity: 0.35;
        }

        tfoot tr {
          border-top: 2px solid var(--divider-color);
        }
        tfoot td {
          padding: 9px 12px;
          text-align: right;
          font-weight: 600;
          font-size: 13px;
          color: var(--primary-text-color);
          font-variant-numeric: tabular-nums;
        }
        tfoot td:first-child {
          text-align: left;
          padding-left: 16px;
          color: var(--secondary-text-color);
          font-size: 12px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          position: sticky;
          left: 0;
          background: var(--card-background-color, #1c1c1c);
        }
        tfoot td:last-child { padding-right: 16px; }

        .unit {
          opacity: 0.5;
          font-size: 9.5px;
          margin-left: 1px;
          font-weight: 400;
          letter-spacing: 0;
          text-transform: none;
        }

        .export-wrap {
          position: relative;
        }
        .export-btn {
          background: none;
          border: none;
          cursor: pointer;
          color: var(--primary-text-color);
          opacity: 0.45;
          padding: 4px 6px;
          border-radius: 6px;
          font-size: 15px;
          line-height: 1;
          transition: opacity 0.15s, background 0.15s;
          display: flex;
          align-items: center;
        }
        .export-btn:hover { opacity: 0.9; background: var(--secondary-background-color, rgba(255,255,255,0.06)); }
        .export-menu {
          display: none;
          position: absolute;
          right: 0;
          top: calc(100% + 4px);
          background: var(--card-background-color, #1c1c1c);
          border: 1px solid var(--divider-color, rgba(255,255,255,0.12));
          border-radius: 8px;
          overflow: hidden;
          z-index: 10;
          min-width: 160px;
          box-shadow: 0 4px 16px rgba(0,0,0,0.4);
        }
        .export-menu.open { display: block; }
        .export-menu button {
          display: block;
          width: 100%;
          background: none;
          border: none;
          cursor: pointer;
          padding: 10px 14px;
          text-align: left;
          font-size: 13px;
          color: var(--primary-text-color);
          transition: background 0.1s;
          white-space: nowrap;
        }
        .export-menu button:hover { background: var(--secondary-background-color, rgba(255,255,255,0.06)); }

        .yoy {
          font-size: 10px;
          font-weight: 500;
          letter-spacing: 0.1px;
          margin-top: 1px;
          font-variant-numeric: tabular-nums;
        }
        .yoy-up   { color: var(--success-color, #4caf50); }
        .yoy-dn   { color: var(--error-color,   #f44336); }
        .yoy-flat { color: var(--secondary-text-color); opacity: 0.6; }
      </style>
      <ha-card>
        <div class="card-header">
          <span>${title}</span>
          <div style="display:flex;align-items:center;gap:6px;">
            <div class="export-wrap">
              <button class="export-btn" id="btn-export" title="Export">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
                </svg>
              </button>
              <div class="export-menu" id="export-menu">
                <button id="btn-copy">Copy as TSV</button>
                <button id="btn-download">Download CSV</button>
              </div>
            </div>
            <div class="year-nav">
              <button id="btn-prev">&#8249;</button>
              <span class="year-label">${this._year}</span>
              <button id="btn-next" ${this._year >= currentYear ? 'disabled' : ''}>&#8250;</button>
            </div>
          </div>
        </div>
        <div class="table-wrap">
          <div class="table-scroll" id="tscroll">
            <table>
              <thead>
                <tr>
                  <th>Month</th>
                  ${entities.map(e => `<th>${e.name}${e.unit ? `<span class="unit">${e.unit}</span>` : ''}</th>`).join('')}
                </tr>
              </thead>
              <tbody>
                ${rows.map((row, m) => `
                  <tr class="${isCurrentYear && row.monthIndex === currentMonth ? 'current-month' : ''}">
                    <td>${row.label}</td>
                    ${row.values.map((v, i) => {
                      const hasVal = v !== null && !isNaN(v);
                      const yoy = this._yoyHtml(v, row.prev ? row.prev[i] : null, entities[i]);
                      const momPrev = row.monthIndex > 0 ? allRows[row.monthIndex - 1].values[i] : null;
                      const mom = entities[i].mom ? this._deltaHtml(v, momPrev, entities[i], entities[i].mom) : '';
                      return `<td class="${hasVal ? 'has-value' : 'no-value'}">${this._fmt(v, entities[i].decimals)}${yoy}${mom}</td>`;
                    }).join('')}
                  </tr>
                `).join('')}
              </tbody>
              <tfoot>
                <tr>
                  <td>Total</td>
                  ${totals.map((t, i) => {
                    const yoy = prevTotals ? this._yoyHtml(t, prevTotals[i], entities[i]) : '';
                    return `<td>${this._fmt(t, entities[i].decimals)}${yoy}</td>`;
                  }).join('')}
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      </ha-card>
    `;

    root.getElementById('btn-prev').addEventListener('click', () => {
      this._year--;
      this._fetchAndRender();
    });

    const btnNext = root.getElementById('btn-next');
    if (btnNext && this._year < currentYear) {
      btnNext.addEventListener('click', () => {
        this._year++;
        this._fetchAndRender();
      });
    }

    const fallbackCopy = (text, onDone) => {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0;';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      // execCommand is deprecated but remains the only clipboard option on non-HTTPS origins
      try { document.execCommand('copy'); onDone(); } catch (_) {}
      document.body.removeChild(ta);
    };

    const exportBtn = root.getElementById('btn-export');
    const exportMenu = root.getElementById('export-menu');

    exportBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      exportMenu.classList.toggle('open');
    });

    if (this._closeExportMenu) document.removeEventListener('click', this._closeExportMenu);
    this._closeExportMenu = () => exportMenu.classList.remove('open');
    document.addEventListener('click', this._closeExportMenu);

    const buildExportData = () => {
      const header = ['Month', ...entities.map(e => e.unit ? `${e.name} (${e.unit})` : e.name)];
      const dataRows = rows.map((row) => [
        row.label,
        ...row.values.map((v, i) => v !== null && !isNaN(v) ? v.toFixed(entities[i].decimals) : ''),
      ]);
      const totalRow = ['Total', ...totals.map((t, i) => this._fmt(t, entities[i].decimals))];
      return [header, ...dataRows, totalRow];
    };

    root.getElementById('btn-copy').addEventListener('click', () => {
      const tsv = buildExportData().map(r => r.join('\t')).join('\n');
      const confirm = () => {
        const btn = root.getElementById('btn-copy');
        if (btn) { btn.textContent = 'Copied!'; setTimeout(() => { btn.textContent = 'Copy as TSV'; }, 1500); }
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(tsv).then(confirm).catch(() => fallbackCopy(tsv, confirm));
      } else {
        fallbackCopy(tsv, confirm);
      }
      exportMenu.classList.remove('open');
    });

    root.getElementById('btn-download').addEventListener('click', () => {
      const csv = buildExportData().map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
      const blob = new Blob([csv], { type: 'text/csv' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${title.replace(/\s+/g, '_')}_${this._year}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
      exportMenu.classList.remove('open');
    });

  }

  getCardSize() {
    return 8;
  }

  getGridOptions() {
    return { columns: 18, rows: 'auto' };
  }

  static getStubConfig() {
    return {
      title: 'Monthly Statistics',
      entities: [
        { entity: 'sensor.example_energy', name: 'Import', unit: 'kWh', decimals: 1 },
      ],
    };
  }
}

customElements.define('statistics-table-card', StatisticsTableCard);

window.customCards = window.customCards || [];
window.customCards.push({
  type: 'statistics-table-card',
  name: 'Statistics Table Card',
  description: 'Displays long-term statistics in a table with period navigation, MoM/YoY comparisons, and CSV export',
  preview: false,
  documentationURL: 'https://github.com/Zarvinx/statistics-table-card',
});
