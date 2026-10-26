    function createWeaponInputRow() {
        const container = document.createElement('div');
        container.id = WEAPON_INPUT_ID;
        container.style.fontSize = '12px';
        container.style.lineHeight = '1.5';
        container.style.marginTop = '5px';
        container.style.color = '#66c0f4';
        container.style.overflowWrap = 'anywhere';
        return container;
    }

    function setWeaponInputStatus(container, message, href = null, title = '') {
        if (!container) return;
        container.replaceChildren();
        const element = document.createElement(href ? 'a' : 'span');
        element.textContent = message;
        element.title = title || message;
        if (href) {
            element.href = href;
            element.target = '_blank';
            element.rel = 'noopener noreferrer';
            element.style.color = '#66c0f4';
            element.style.textDecoration = 'underline';
        }
        container.appendChild(element);
    }

    function showSelectedWeaponOffers(container, selected, verified, estimate = '') {
        if (!container) return;
        container.replaceChildren();
        const summary = document.createElement('div');
        summary.textContent = (verified ? 'Lowest verified among checked listings' :
            'Lowest verified offers among checked listings') +
            (estimate ? ' — estimated material total ' + estimate : '');
        summary.style.color = '#c7d5e0';
        container.appendChild(summary);
        selected.forEach((offer, index) => {
            const line = document.createElement('div');
            const link = document.createElement('a');
            link.href = offer.url;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            link.style.color = '#66c0f4';
            link.style.textDecoration = 'underline';
            link.textContent = (index + 1) + '. ' + offer.name + ' — ' + offer.priceText;
            link.title = 'Individual Steam Market listing price. Confirm availability before buying.';
            line.appendChild(link);
            container.appendChild(line);
        });
    }

    // ============================================================
    // BUTTON
    // ============================================================

    function createButton() {

        const button =
            document.createElement('a');

        button.id =
            BUTTON_ID;

        button.target =
            '_blank';

        button.rel =
            'noopener noreferrer';

        /*
         * Steam applies typography/layout rules to inventory links.
         * Use !important here so Steam cannot override the requested
         * 15px text and 24px button height.
         */
        button.style.setProperty(
            'display',
            'inline-flex',
            'important'
        );

        button.style.setProperty(
            'align-items',
            'center',
            'important'
        );

        button.style.setProperty(
            'justify-content',
            'center',
            'important'
        );

        button.style.setProperty(
            'box-sizing',
            'border-box',
            'important'
        );

        button.style.setProperty(
            'height',
            '24px',
            'important'
        );

        button.style.setProperty(
            'min-height',
            '24px',
            'important'
        );

        button.style.setProperty(
            'max-height',
            '24px',
            'important'
        );

        button.style.setProperty(
            'margin',
            '0',
            'important'
        );

        button.style.setProperty(
            'padding',
            '0 8px',
            'important'
        );

        button.style.setProperty(
            'font-size',
            '15px',
            'important'
        );

        button.style.setProperty(
            'line-height',
            '15px',
            'important'
        );

        button.style.setProperty(
            'font-weight',
            '400',
            'important'
        );

        button.style.setProperty(
            'white-space',
            'nowrap',
            'important'
        );

        button.style.setProperty(
            'width',
            'auto',
            'important'
        );

        button.style.setProperty(
            'min-width',
            '0',
            'important'
        );

        button.style.setProperty(
            'flex',
            '0 1 auto',
            'important'
        );

        button.style.background =
            'linear-gradient(to bottom, #799905 5%, #536904 95%)';

        button.style.color =
            '#d2efa9';

        button.style.textDecoration =
            'none';

        button.style.borderRadius =
            '2px';

        button.style.cursor =
            'pointer';

        button.addEventListener(
            'mouseenter',
            function () {

                this.style.filter =
                    'brightness(1.15)';

                this.style.color =
                    '#ffffff';
            }
        );

        button.addEventListener(
            'mouseleave',
            function () {

                this.style.filter =
                    '';

                this.style.color =
                    '#d2efa9';
            }
        );

        return button;
    }

    function createKitButton() {

        const button =
            createButton();

        button.id =
            KIT_BUTTON_ID;

        return button;
    }

    function createErrorReportButton() {

        const button =
            createButton();

        button.id =
            ERROR_BUTTON_ID;

        button.removeAttribute('href');
        button.removeAttribute('target');
        button.textContent =
            'Error Report (' +
            diagnosticErrorCount +
            ')';
        button.title =
            'Open the TF2 Multi-Buy diagnostic report';
        button.style.background =
            'linear-gradient(to bottom, #b84c4c 5%, #7d2929 95%)';
        button.style.color =
            '#ffd9d9';
        button.style.setProperty(
            'flex',
            '0 0 auto',
            'important'
        );

        button.addEventListener(
            'mouseenter',
            function () {
                this.style.color = '#ffffff';
            }
        );

        button.addEventListener(
            'mouseleave',
            function () {
                this.style.color = '#ffd9d9';
            }
        );

        button.addEventListener(
            'click',
            event => {
                event.preventDefault();
                openErrorReportDialog();
            }
        );

        return button;
    }

    function createButtonSpacer(referenceElement) {

        const spacer =
            document.createElement('div');

        spacer.id =
            BUTTON_SPACER_ID;

        /*
         * Match Steam's own blank-line rows in the item description.
         * Reuse the same classes as the robot-part text when possible
         * so the spacing remains natural if Steam changes its styling.
         */
        if (referenceElement) {

            spacer.className =
                referenceElement.className || '';

        }

        spacer.innerHTML =
            '&nbsp;';

        spacer.style.setProperty(
            '--white-space',
            'pre-line'
        );

        spacer.style.setProperty(
            'min-height',
            '1em',
            'important'
        );

        return spacer;
    }

    function createButtonContainer() {

        const container =
            document.createElement('div');

        container.id =
            BUTTON_CONTAINER_ID;

        /*
         * Both buttons live inside this one flex row.
         * This prevents Steam's surrounding inventory layout from
         * placing the second button on a separate line.
         */
        container.style.setProperty(
            'display',
            'flex',
            'important'
        );

        container.style.setProperty(
            'flex-direction',
            'row',
            'important'
        );

        container.style.setProperty(
            'align-items',
            'center',
            'important'
        );

        container.style.setProperty(
            'justify-content',
            'flex-start',
            'important'
        );

        container.style.setProperty(
            'flex-wrap',
            'nowrap',
            'important'
        );

        container.style.setProperty(
            'gap',
            '6px',
            'important'
        );

        container.style.setProperty(
            'width',
            '100%',
            'important'
        );

        container.style.setProperty(
            'max-width',
            '100%',
            'important'
        );

        container.style.setProperty(
            'min-width',
            '0',
            'important'
        );

        container.style.setProperty(
            'box-sizing',
            'border-box',
            'important'
        );

        container.style.setProperty(
            'align-self',
            'stretch',
            'important'
        );

        container.style.setProperty(
            'height',
            '24px',
            'important'
        );

        container.style.setProperty(
            'margin',
            '0',
            'important'
        );

        container.style.setProperty(
            'padding',
            '0',
            'important'
        );

        container.style.setProperty(
            'overflow',
            'hidden',
            'important'
        );

        return container;
    }

    function fitButtonsToContainer(
        container,
        ...buttons
    ) {

        if (!container || buttons.length === 0)
            return;

        /*
         * Start at the requested 15px. If Steam's item-card column is
         * too narrow for both labels, step the text down only as much
         * as required rather than allowing the row to spill outside
         * the card.
         */
        let fontSize = 15;
        const minimumFontSize = 11;

        for (const button of buttons) {
            button.style.setProperty(
                'font-size',
                fontSize + 'px',
                'important'
            );
        }

        const fits = () => {

            const gap = 6;

            const requiredWidth =
                buttons.reduce(
                    (total, button) =>
                        total + button.scrollWidth,
                    0
                ) +
                gap * (buttons.length - 1);

            return (
                requiredWidth <=
                container.clientWidth
            );
        };

        while (
            !fits() &&
            fontSize > minimumFontSize
        ) {

            fontSize -= 0.5;

            for (const button of buttons) {
                button.style.setProperty(
                    'font-size',
                    fontSize + 'px',
                    'important'
                );
            }
        }

        /*
         * If an unusually narrow inventory layout still cannot fit
         * both labels, split the available row proportionally rather
         * than allowing anything to overlap the card.
         */
        for (const button of buttons) {
            button.style.setProperty(
                'overflow',
                'hidden',
                'important'
            );

            button.style.setProperty(
                'text-overflow',
                'ellipsis',
                'important'
            );
        }
    }

    // ============================================================
    // UPDATE SELECTED INVENTORY ITEM
    // ============================================================
