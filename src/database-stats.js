    function formatDBStatsTime(value) {
        const date = new Date(value);
        if (!value || !Number.isFinite(date.getTime())) return 'Not yet updated';
        const pad = number => String(number).padStart(2, '0');
        const hour = date.getHours();
        return pad(hour % 12 || 12) + ':' + pad(date.getMinutes()) + (hour < 12 ? ' am, ' : ' pm, ') +
            pad(date.getDate()) + '/' + pad(date.getMonth() + 1) + '/' + date.getFullYear();
    }

    function showDatabaseStats(opener) {
        const existing = document.getElementById('tf2-price-db-stats-dialog');
        if (existing) { existing.querySelector('button')?.focus?.(); return; }
        const overlay = document.createElement('div');
        overlay.id = 'tf2-price-db-stats-dialog';
        overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483646;background:#000a;display:flex;' +
            'align-items:center;justify-content:center;padding:16px;box-sizing:border-box;';
        const panel = document.createElement('div');
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-modal', 'true');
        panel.setAttribute('aria-labelledby', 'tf2-price-db-stats-title');
        panel.style.cssText = 'width:940px;max-width:100%;max-height:85vh;display:flex;flex-direction:column;' +
            'background:#1b2838;color:#c7d5e0;border:1px solid #6388a0;border-radius:5px;' +
            'box-shadow:0 12px 40px #000a;font:13px/1.5 Arial,sans-serif;text-align:left;';
        const header = document.createElement('div');
        header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:12px 16px;gap:12px;';
        const title = document.createElement('strong');
        title.id = 'tf2-price-db-stats-title';
        title.textContent = 'DB Stats';
        title.style.cssText = 'color:white;font-size:18px;';
        const close = document.createElement('button');
        close.id = 'tf2-price-db-stats-close';
        close.type = 'button';
        close.textContent = 'Close';
        close.style.cssText = 'padding:6px 10px;background:#375877;border:1px solid #6388a0;border-radius:3px;color:white;cursor:pointer;';
        header.append(title, close);
        panel.appendChild(header);
        const summary = document.createElement('div');
        summary.style.cssText = 'padding:0 16px 12px;color:#a8b9c7;';
        panel.appendChild(summary);
        const content = document.createElement('div');
        content.style.cssText = 'overflow:auto;padding:0 16px 16px;min-height:0;';
        content.tabIndex = 0;
        content.setAttribute('role', 'region');
        content.setAttribute('aria-label', 'Weapon prices grouped by update time');
        panel.appendChild(content);
        overlay.appendChild(panel);
        document.body.appendChild(overlay);
        const previousOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        const dismiss = () => {
            document.removeEventListener('keydown', onKey);
            overlay.remove();
            document.body.style.overflow = previousOverflow;
            if (opener?.isConnected) opener.focus?.();
        };
        const onKey = event => {
            if (event.key === 'Escape') { event.preventDefault(); dismiss(); }
            if (event.key === 'Tab') {
                event.preventDefault();
                (document.activeElement === close ? content : close).focus?.();
            }
        };
        close.addEventListener('click', dismiss);
        overlay.addEventListener('click', event => { if (event.target === overlay) dismiss(); });
        document.addEventListener('keydown', onKey);
        close.focus?.();

        const rows = priceDatabase.rows ? [...priceDatabase.rows.values()] : [];
        if (!rows.length) {
            summary.textContent = 'Price database not loaded. Use Check GitHub for update, then reopen DB Stats.';
            return;
        }
        const priced = rows.filter(row => row.status === 'priced' && Number.isFinite(row.price) && row.price > 0).length;
        summary.textContent = rows.length + ' entries • ' + priced + ' priced • ' + (rows.length - priced) +
            ' without a verified price. Times are local. Groups use quote update times; prices are saved ' + priceDatabase.currency + ' snapshots.';
        const groups = new Map();
        const unpriced = [];
        for (const row of rows) {
            const time = Date.parse(row.checkedAtUTC);
            if (row.status !== 'priced' || !Number.isFinite(time) || !Number.isFinite(row.price) || row.price <= 0) {
                unpriced.push(row);
                continue;
            }
            // Align buckets to local :00/:30, including time zones offset by 45 minutes.
            // Keep the offset in the key so repeated times at a DST change remain distinct.
            const offset = new Date(time).getTimezoneOffset() * 60000;
            const bucket = Math.floor((time - offset) / 1800000) * 1800000 + offset;
            if (!groups.has(bucket)) groups.set(bucket, []);
            groups.get(bucket).push(row);
        }
        const renderGroup = (label, items, bucket) => {
            const section = document.createElement('section');
            section.style.cssText = 'margin:0 0 18px;';
            if (bucket !== null) section.setAttribute('data-bucket-start', new Date(bucket).toISOString());
            const heading = document.createElement('h3');
            heading.textContent = label + ' (' + items.length + ')';
            heading.style.cssText = 'position:sticky;top:0;background:#23364a;color:white;padding:8px;margin:0;font-size:13px;';
            section.appendChild(heading);
            const table = document.createElement('table');
            table.style.cssText = 'width:100%;border-collapse:collapse;';
            const head = document.createElement('thead');
            const labels = document.createElement('tr');
            for (const label of ['Weapon', 'Price', 'Quote updated']) {
                const th = document.createElement('th');
                th.textContent = label;
                th.style.cssText = 'text-align:left;padding:7px;border-bottom:1px solid #526477;';
                labels.appendChild(th);
            }
            head.appendChild(labels);
            table.appendChild(head);
            const body = document.createElement('tbody');
            for (const row of [...items].sort((a, b) => a.name.localeCompare(b.name))) {
                const tr = document.createElement('tr');
                const name = document.createElement('td');
                name.textContent = row.name;
                const price = document.createElement('td');
                price.textContent = row.status === 'priced' && Number.isFinite(row.price) && row.price > 0
                    ? priceDatabase.currency + ' ' + row.price.toFixed(2) : 'No verified price';
                const updated = document.createElement('td');
                updated.textContent = formatDBStatsTime(row.checkedAtUTC);
                updated.style.whiteSpace = 'nowrap';
                const history = priceUpdateSchedule.data?.attemptHistory?.[row.name];
                const rowAttempt = Date.parse(row.lastAttemptAtUTC);
                const historyAttempt = Date.parse(history?.atUTC);
                const latest = Number.isFinite(historyAttempt) && (!Number.isFinite(rowAttempt) || historyAttempt >= rowAttempt)
                    ? {at: history.atUTC, result: history.result} : {at: row.lastAttemptAtUTC, result: row.lastResult};
                if (latest.result === 'no_active_listings') {
                    const note = document.createElement('div');
                    note.textContent = 'No active listings at last check: ' + formatDBStatsTime(latest.at);
                    note.style.cssText = 'font-size:11px;color:#a8b9c7;';
                    price.appendChild(note);
                }
                for (const cell of [name, price, updated]) {
                    cell.style.cssText += ';padding:8px 7px;border-bottom:1px solid #34485c;vertical-align:top;';
                    tr.appendChild(cell);
                }
                body.appendChild(tr);
            }
            table.appendChild(body);
            section.appendChild(table);
            content.appendChild(section);
        };
        for (const [bucket, items] of [...groups].sort((a, b) => b[0] - a[0])) {
            const zone = new Intl.DateTimeFormat(undefined, {timeZoneName: 'short'})
                .formatToParts(new Date(bucket)).find(part => part.type === 'timeZoneName')?.value || '';
            const end = formatDBStatsTime(bucket + 1800000).split(',')[0];
            renderGroup(formatDBStatsTime(bucket) + ' – ' + end + ' ' + zone, items, bucket);
        }
        if (unpriced.length) renderGroup('No verified price', unpriced, null);
    }
