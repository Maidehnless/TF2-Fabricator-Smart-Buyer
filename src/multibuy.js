    async function getMultiBuyTotal(url, expectedPositiveRows = null, options = {}) {

        writeDiagnostic('log',
            '[TF2 MultiBuy] Fetching:',
            url
        );

        const html =
            await requestHTML(url, options);

        writeDiagnostic('log',
            '[TF2 MultiBuy] Received HTML:',
            html.length,
            'characters'
        );

        const parser =
            new DOMParser();

        const doc =
            parser.parseFromString(
                html,
                'text/html'
            );

        /*
         * These are the same price inputs Steam's
         * UpdateOrderTotal() function reads.
         */
        const priceInputs =
            [
                ...doc.querySelectorAll(
                    '.market_multi_price'
                )
            ];

        writeDiagnostic('log',
            '[TF2 MultiBuy] Price inputs found:',
            priceInputs.length
        );

        if (priceInputs.length === 0) {

            /*
             * Useful information if Steam returned
             * a login/error page.
             */
            writeDiagnostic('log',
                '[TF2 MultiBuy] Page title:',
                doc.title
            );

            writeDiagnostic('log',
                '[TF2 MultiBuy] Page summary:',
                {
                    htmlLength:
                        html.length,
                    bodyTextLength:
                        doc.body && doc.body.textContent
                            ? doc.body.textContent.length
                            : 0
                }
            );

            throw new Error(
                'Steam multibuy page contained no price fields.'
            );
        }

        const requested = new URL(url).searchParams;
        const expectedNames = requested.getAll('items[]');
        const expectedQty = requested.getAll('qty[]');
        const expected = new Map(expectedNames.map((name,i) => [normalizeMarketName(name), Number(expectedQty[i])]));
        const matched = new Set();
        let totalMinorUnits = 0;
        let priceFormat = null;
        let pricedItems = 0;

        for (const priceInput of priceInputs) {

            const nameID =
                priceInput.getAttribute(
                    'data-nameid'
                );

            let quantityInput = null;

            /*
             * This mirrors Steam's own selector:
             *
             * #buy_NAMEID_qty
             */
            if (nameID) {

                quantityInput =
                    doc.getElementById(
                        'buy_' +
                        nameID +
                        '_qty'
                    );
            }

            /*
             * Fallback in case Steam changes
             * the quantity ID.
             */
            if (!quantityInput) {

                const row =
                    priceInput.closest('tr');

                if (row) {

                    quantityInput =
                        row.querySelector(
                            '.market_multi_quantity'
                        );
                }
            }

            if (!quantityInput)
                continue;

            const quantity =
                parseInt(
                    quantityInput.value,
                    10
                );

            if (
                !Number.isFinite(quantity) ||
                quantity <= 0
            ) {
                continue;
            }

            const row = priceInput.closest('.market_multi_buy_row, .market_listing_row, tr') ||
                doc.getElementById('buy_' + nameID);
            const names = [...(row?.querySelectorAll('a[href*="/market/listings/440/"]') || [])].map(a => {
                try { return normalizeMarketName(decodeURIComponent(new URL(a.getAttribute('href'), 'https://steamcommunity.com').pathname.split('/market/listings/440/')[1])); }
                catch (_) { return ''; }
            });
            const name = names.find(n => expected.has(n));
            if (!name || matched.has(name) || expected.get(name) !== quantity)
                throw Error('Steam Multi-Buy row identity or quantity does not match the requested recipe.');
            matched.add(name);

            const priceText =
                priceInput.value;

            const parsedPrice =
                parseSteamPrice(
                    priceText
                );

            writeDiagnostic('log',
                '[TF2 MultiBuy] Row:',
                {
                    nameID,
                    priceText,
                    parsedPrice,
                    quantity
                }
            );

            if (
                !parsedPrice ||
                parsedPrice.minorUnits <= 0
            ) {

                throw new Error(
                    'Could not parse Steam price "' +
                    priceText +
                    '".'
                );
            }

            if (!priceFormat) {

                priceFormat =
                    parsedPrice.format;

            } else if (
                parsedPrice.format.decimals !==
                    priceFormat.decimals ||
                parsedPrice.format.prefix !==
                    priceFormat.prefix ||
                parsedPrice.format.suffix !==
                    priceFormat.suffix
            ) {

                throw new Error(
                    'Steam returned inconsistent currency formatting on the multibuy page.'
                );
            }

            /*
             * Same formula Steam uses:
             *
             * row total = unit price × quantity
             */
            const rowTotal =
                parsedPrice.minorUnits *
                quantity;

            totalMinorUnits +=
                rowTotal;

            pricedItems++;
        }

        if (pricedItems === 0) {

            throw new Error(
                'Steam prices were found but no required quantities could be matched.'
            );
        }

        // Never show a misleading "complete" cost if a weapon (or a
        // robot part) was silently omitted by Steam's Multi-Buy page.
        if (matched.size !== expected.size || (expectedPositiveRows !== null && pricedItems !== expectedPositiveRows)) {
            throw new Error(
                'Steam Multi-Buy priced ' + pricedItems + ' of ' +
                expectedPositiveRows + ' required item types. ' +
                'One or more items may not be supported by Multi-Buy.'
            );
        }

        const formattedTotal =
            formatSteamCurrency(
                totalMinorUnits,
                priceFormat
            );

        writeDiagnostic('log',
            '[TF2 MultiBuy] Final total:',
            formattedTotal
        );

        return {
            minorUnits:
                totalMinorUnits,

            format:
                priceFormat,

            formatted:
                formattedTotal
        };
    }

    // ============================================================
    // FINISHED KIT BUY ORDER
    // ============================================================
