    function redactDiagnosticText(text) {

        return String(text)
            .replace(
                /(\b(?:sessionid|access_token|steamLoginSecure)\b["']?\s*[=:]\s*["']?)[^\s&,}"']+/gi,
                '$1[redacted]'
            );
    }

    function stringifyDiagnosticValue(value) {

        if (typeof value === 'string')
            return redactDiagnosticText(value);

        if (
            value === null ||
            typeof value === 'undefined' ||
            typeof value === 'number' ||
            typeof value === 'boolean' ||
            typeof value === 'bigint'
        ) {
            return String(value);
        }

        if (
            value instanceof Error ||
            (
                typeof value === 'object' &&
                typeof value.message === 'string' &&
                typeof value.stack === 'string'
            )
        ) {
            // Firefox Error.stack often contains only stack frames and
            // omits the exception message. Always include both.
            return redactDiagnosticText(
                (value.name || 'Error') + ': ' +
                (value.message || '(no message)') +
                (value.stack ? '\n' + value.stack : '')
            );
        }

        try {

            const seen =
                new WeakSet();

            const json =
                JSON.stringify(
                    value,
                    (key, nestedValue) => {

                        if (
                            nestedValue &&
                            typeof nestedValue === 'object'
                        ) {

                            if (seen.has(nestedValue))
                                return '[Circular]';

                            seen.add(nestedValue);
                        }

                        if (nestedValue instanceof Error) {
                            return {
                                name:
                                    nestedValue.name,
                                message:
                                    nestedValue.message,
                                stack:
                                    nestedValue.stack
                            };
                        }

                        return nestedValue;
                    },
                    2
                );

            if (typeof json === 'string')
                return redactDiagnosticText(json);

        } catch (error) {
            // Fall through to String(value).
        }

        try {
            return redactDiagnosticText(String(value));
        } catch (error) {
            return '[Unprintable value]';
        }
    }

    function buildErrorReportText() {

        const browser =
            typeof navigator !== 'undefined'
                ? navigator.userAgent
                : 'Unavailable';

        const language =
            typeof navigator !== 'undefined'
                ? navigator.language
                : 'Unavailable';

        const lines = [
            'Steam TF2 Fabricator Robot Parts Multi-Buy error report',
            'Script version: ' + SCRIPT_VERSION,
            'Generated: ' + new Date().toISOString(),
            'Browser: ' + browser,
            'Language: ' + language,
            'Recorded errors: ' + diagnosticErrorCount,
            '',
            'Userscript diagnostic log:',
            ''
        ];

        return lines
            .concat(
                diagnosticEntries.length > 0
                    ? diagnosticEntries
                    : ['No diagnostic entries were recorded.']
            )
            .join('\n');
    }

    function refreshErrorReportUI() {

        const button =
            document.getElementById(
                ERROR_BUTTON_ID
            );

        if (button) {
            button.textContent =
                'Error Report (' +
                diagnosticErrorCount +
                ')';
        }

        const logArea =
            document.getElementById(
                ERROR_LOG_ID
            );

        if (logArea) {
            logArea.textContent =
                buildErrorReportText();

            logArea.scrollTop =
                logArea.scrollHeight;
        }
    }

    function writeDiagnostic(level, ...values) {

        const consoleMethod =
            nativeConsole[level] ||
            nativeConsole.log;

        consoleMethod(...values);

        const entry =
            '[' +
            new Date().toISOString() +
            '] [' +
            String(level || 'log').toUpperCase() +
            '] ' +
            values
                .map(stringifyDiagnosticValue)
                .join(' ');

        diagnosticEntries.push(entry);

        if (level === 'error') {

            diagnosticErrorCount++;

            setTimeout(
                ensureErrorReportButton,
                0
            );
        }

        refreshErrorReportUI();
    }

    function ensureErrorReportButton() {

        if (diagnosticErrorCount <= 0)
            return null;

        const container =
            document.getElementById(
                BUTTON_CONTAINER_ID
            );

        if (!container)
            return null;

        let button =
            document.getElementById(
                ERROR_BUTTON_ID
            );

        if (!button) {

            button =
                createErrorReportButton();

            container.appendChild(button);
        }

        refreshErrorReportUI();

        requestAnimationFrame(
            () =>
                fitButtonsToContainer(
                    container,
                    ...container.querySelectorAll('a')
                )
        );

        return button;
    }

    async function copyTextToClipboard(text) {

        if (
            navigator.clipboard &&
            typeof navigator.clipboard.writeText === 'function'
        ) {
            await navigator.clipboard.writeText(text);
            return;
        }

        const textArea =
            document.createElement('textarea');

        textArea.value = text;
        textArea.setAttribute('readonly', '');
        textArea.style.position = 'fixed';
        textArea.style.opacity = '0';

        document.body.appendChild(textArea);
        textArea.select();

        const copied =
            document.execCommand('copy');

        textArea.remove();

        if (!copied)
            throw new Error('The browser rejected the clipboard request.');
    }

    function styleDialogButton(button, primary = false) {

        button.style.border =
            '1px solid ' +
            (primary ? '#7aa72a' : '#53606d');
        button.style.borderRadius = '3px';
        button.style.background =
            primary ? '#6b8e23' : '#303b47';
        button.style.color = '#ffffff';
        button.style.padding = '5px 10px';
        button.style.fontSize = '12px';
        button.style.cursor = 'pointer';
    }

    function closeErrorReportDialog() {

        const overlay =
            document.getElementById(
                ERROR_DIALOG_ID
            );

        if (!overlay)
            return;

        if (overlay.escapeHandler) {
            window.removeEventListener(
                'keydown',
                overlay.escapeHandler
            );
        }

        overlay.remove();
    }

    function openErrorReportDialog() {

        const existing =
            document.getElementById(
                ERROR_DIALOG_ID
            );

        if (existing) {
            refreshErrorReportUI();
            return;
        }

        const overlay =
            document.createElement('div');

        overlay.id = ERROR_DIALOG_ID;
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'true');
        overlay.setAttribute('aria-label', 'TF2 Multi-Buy error report');
        overlay.style.position = 'fixed';
        overlay.style.inset = '0';
        overlay.style.zIndex = '999999';
        overlay.style.display = 'flex';
        overlay.style.alignItems = 'center';
        overlay.style.justifyContent = 'center';
        overlay.style.padding = '20px';
        overlay.style.boxSizing = 'border-box';
        overlay.style.background = 'rgba(0, 0, 0, 0.72)';

        const dialog =
            document.createElement('div');

        dialog.style.width = 'min(760px, 96vw)';
        dialog.style.maxHeight = '90vh';
        dialog.style.display = 'flex';
        dialog.style.flexDirection = 'column';
        dialog.style.gap = '12px';
        dialog.style.padding = '16px';
        dialog.style.boxSizing = 'border-box';
        dialog.style.border = '1px solid #4b6075';
        dialog.style.borderRadius = '5px';
        dialog.style.background = '#1b2838';
        dialog.style.color = '#d6d7d8';
        dialog.style.boxShadow = '0 12px 45px rgba(0, 0, 0, 0.7)';
        dialog.style.fontFamily = 'Arial, Helvetica, sans-serif';

        const headingRow =
            document.createElement('div');

        headingRow.style.display = 'flex';
        headingRow.style.alignItems = 'center';
        headingRow.style.justifyContent = 'space-between';
        headingRow.style.gap = '12px';

        const heading =
            document.createElement('strong');

        heading.textContent = 'TF2 Multi-Buy Error Report';
        heading.style.fontSize = '18px';
        heading.style.color = '#ffffff';

        const topCloseButton =
            document.createElement('button');

        topCloseButton.type = 'button';
        topCloseButton.textContent = 'Close';
        styleDialogButton(topCloseButton);
        topCloseButton.addEventListener(
            'click',
            closeErrorReportDialog
        );

        headingRow.appendChild(heading);
        headingRow.appendChild(topCloseButton);

        const logArea =
            document.createElement('pre');

        logArea.id = ERROR_LOG_ID;
        logArea.textContent = buildErrorReportText();
        logArea.style.height = 'min(50vh, 440px)';
        logArea.style.minHeight = '180px';
        logArea.style.margin = '0';
        logArea.style.padding = '12px';
        logArea.style.boxSizing = 'border-box';
        logArea.style.overflow = 'auto';
        logArea.style.whiteSpace = 'pre-wrap';
        logArea.style.overflowWrap = 'anywhere';
        logArea.style.border = '1px solid #3d4e5f';
        logArea.style.borderRadius = '3px';
        logArea.style.background = '#101822';
        logArea.style.color = '#dcdedf';
        logArea.style.fontFamily = 'Consolas, Monaco, monospace';
        logArea.style.fontSize = '12px';
        logArea.style.lineHeight = '1.45';
        logArea.style.userSelect = 'text';

        const reportMessage =
            document.createElement('div');

        reportMessage.style.fontSize = '14px';
        reportMessage.style.lineHeight = '1.5';

        reportMessage.appendChild(
            document.createTextNode(
                'Oopsie Doopsie you have encountered an error, feel free to send these logs to the amazing and cool '
            )
        );

        const discordLink =
            document.createElement('a');

        discordLink.href =
            'https://discord.com/users/268722078633558019';
        discordLink.target = '_blank';
        discordLink.rel = 'noopener noreferrer';
        discordLink.textContent = 'maidehnless';
        discordLink.style.color = '#66c0f4';
        discordLink.style.textDecoration = 'underline';

        reportMessage.appendChild(discordLink);
        reportMessage.appendChild(
            document.createTextNode(' on discord')
        );

        const actionRow =
            document.createElement('div');

        actionRow.style.display = 'flex';
        actionRow.style.justifyContent = 'flex-end';
        actionRow.style.gap = '8px';

        const copyButton =
            document.createElement('button');

        copyButton.type = 'button';
        copyButton.textContent = 'Copy all logs';
        styleDialogButton(copyButton, true);

        copyButton.addEventListener(
            'click',
            async () => {

                const originalText =
                    copyButton.textContent;

                try {

                    await copyTextToClipboard(
                        buildErrorReportText()
                    );

                    copyButton.textContent = 'Copied!';

                } catch (error) {

                    nativeConsole.error(
                        '[TF2 Error Report] COPY ERROR:',
                        error
                    );

                    copyButton.textContent = 'Copy failed';
                }

                setTimeout(
                    () => {
                        copyButton.textContent = originalText;
                    },
                    1800
                );
            }
        );

        const bottomCloseButton =
            document.createElement('button');

        bottomCloseButton.type = 'button';
        bottomCloseButton.textContent = 'Close';
        styleDialogButton(bottomCloseButton);
        bottomCloseButton.addEventListener(
            'click',
            closeErrorReportDialog
        );

        actionRow.appendChild(copyButton);
        actionRow.appendChild(bottomCloseButton);

        dialog.appendChild(headingRow);
        dialog.appendChild(logArea);
        dialog.appendChild(reportMessage);
        dialog.appendChild(actionRow);
        overlay.appendChild(dialog);

        overlay.addEventListener(
            'click',
            event => {
                if (event.target === overlay)
                    closeErrorReportDialog();
            }
        );

        overlay.escapeHandler =
            event => {
                if (event.key === 'Escape')
                    closeErrorReportDialog();
            };

        window.addEventListener(
            'keydown',
            overlay.escapeHandler
        );

        document.body.appendChild(overlay);
        logArea.scrollTop = logArea.scrollHeight;
        topCloseButton.focus();
    }
