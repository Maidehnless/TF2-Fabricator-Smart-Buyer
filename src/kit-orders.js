    function extractListingOrderContext(html) {

        const itemNameIDPatterns = [
            /Market_LoadOrderSpread\s*\(\s*(\d+)\s*\)/i,
            /["']item_nameid["']\s*:\s*["']?(\d+)["']?/i,
            /\bitem_nameid\b\s*[:=]\s*["']?(\d+)["']?/i
        ];

        let itemNameID = null;

        for (const pattern of itemNameIDPatterns) {

            const match =
                String(html || '').match(pattern);

            if (match) {
                itemNameID = match[1];
                break;
            }
        }

        const countryMatch =
            String(html || '').match(
                /\bg_strCountryCode\s*=\s*["']([A-Za-z]{2})["']/i
            );

        const currencyMatch =
            String(html || '').match(
                /["']wallet_currency["']\s*:\s*(\d+)/i
            ) ||
            String(html || '').match(
                /\bwallet_currency\b\s*[:=]\s*(\d+)/i
            );

        return {
            itemNameID,
            countryCode:
                countryMatch
                    ? countryMatch[1].toUpperCase()
                    : 'US',
            currencyID:
                currencyMatch
                    ? currencyMatch[1]
                    : '1'
        };
    }

    function buildOrderHistogramURL(context) {

        const parameters =
            new URLSearchParams({
                country:
                    context.countryCode,
                language:
                    'english',
                currency:
                    context.currencyID,
                item_nameid:
                    context.itemNameID,
                two_factor:
                    '0',
                norender:
                    '1'
            });

        return (
            'https://steamcommunity.com/market/itemordershistogram?' +
            parameters.toString()
        );
    }

    function inferHistogramDecimals(
        histogram,
        highestBuyOrder,
        fallbackDecimals
    ) {

        const graphPrice =
            Array.isArray(histogram.buy_order_graph) &&
            Array.isArray(histogram.buy_order_graph[0])
                ? Number(histogram.buy_order_graph[0][0])
                : NaN;

        if (
            Number.isFinite(graphPrice) &&
            graphPrice > 0
        ) {

            for (let decimals = 0; decimals <= 3; decimals++) {

                const scaledGraphPrice =
                    Math.round(
                        graphPrice *
                        Math.pow(10, decimals)
                    );

                if (scaledGraphPrice === highestBuyOrder) {
                    return decimals;
                }
            }
        }

        return fallbackDecimals;
    }

    function extractHighestBuyOrderFromHistogram(
        histogram,
        kitName
    ) {

        if (
            !histogram ||
            !(
                histogram.success === true ||
                histogram.success === 1 ||
                histogram.success === '1'
            )
        ) {
            throw new Error(
                'Steam returned an unsuccessful order-book response for ' +
                kitName
            );
        }

        const highestBuyOrder =
            Number.parseInt(
                histogram.highest_buy_order,
                10
            );

        if (
            !Number.isFinite(highestBuyOrder) ||
            highestBuyOrder <= 0
        ) {

            const error =
                new Error(
                    'There are currently no buy orders for this kit.'
                );

            error.noBuyOrders = true;

            throw error;
        }

        let priceText =
            typeof histogram.buy_order_price === 'string'
                ? histogram.buy_order_price.trim()
                : '';

        if (
            !priceText &&
            typeof histogram.buy_order_summary === 'string'
        ) {

            const summaryDocument =
                new DOMParser().parseFromString(
                    histogram.buy_order_summary,
                    'text/html'
                );

            const summaryText =
                (
                    summaryDocument.body
                        ? (
                            summaryDocument.body.innerText ||
                            summaryDocument.body.textContent
                        )
                        : summaryDocument.documentElement.textContent
                )
                    .replace(/\u00A0/g, ' ')
                    .replace(/\s+/g, ' ')
                    .trim();

            const summaryMatch =
                summaryText.match(
                    /\brequests?\s+to\s+buy\s+at\s+(.{1,40}?)\s+or\s+lower\b/i
                );

            if (summaryMatch)
                priceText = summaryMatch[1].trim();
        }

        if (
            !priceText &&
            Array.isArray(histogram.buy_order_graph) &&
            Array.isArray(histogram.buy_order_graph[0]) &&
            typeof histogram.buy_order_graph[0][2] === 'string'
        ) {

            const graphMatch =
                histogram.buy_order_graph[0][2].match(
                    /\bat\s+(.{1,40}?)\s+or\s+higher\b/i
                );

            if (graphMatch)
                priceText = graphMatch[1].trim();
        }

        const parsedPrice =
            parseSteamPrice(priceText);

        let format =
            parsedPrice
                ? parsedPrice.format
                : {
                    prefix:
                        String(
                            histogram.price_prefix || ''
                        ),
                    suffix:
                        String(
                            histogram.price_suffix || ''
                        ),
                    decimalSeparator:
                        '.',
                    decimals:
                        2
                };

        format = {
            ...format,
            minorUnitDecimals:
                inferHistogramDecimals(
                    histogram,
                    highestBuyOrder,
                    format.decimals
                )
        };

        const formattedPrice =
            priceText ||
            formatSteamCurrency(
                highestBuyOrder,
                format
            );

        writeDiagnostic('log',
            '[TF2 Kit BuyOrder] Order-book buy order:',
            kitName,
            formattedPrice
        );

        return {
            minorUnits:
                highestBuyOrder,
            format,
            formatted:
                formattedPrice
        };
    }

    function extractHighestBuyOrderFromListingHTML(
        html,
        kitName
    ) {

        const parser =
            new DOMParser();

        const doc =
            parser.parseFromString(
                html,
                'text/html'
            );

        const bodyText =
            (
                doc.body
                    ? (
                        doc.body.innerText ||
                        doc.body.textContent
                    )
                    : doc.documentElement.textContent
            )
                .replace(/\u00A0/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();

        /*
         * Legacy fallback for Steam responses that still render the
         * current top buy order directly in the listing HTML, for example:
         *
         * "40 requests to buy at A$ 1.91 or lower"
         *
         * Current Steam pages normally inject this text after loading
         * the JSON order book, so this must not be the primary lookup.
         */
        const buyOrderMatch =
            bodyText.match(
                /\brequests?\s+to\s+buy\s+at\s+(.{1,40}?)\s+or\s+lower\b/i
            );

        if (!buyOrderMatch) {

            if (
                /\bno\s+(?:active\s+)?buy\s+orders?\b/i.test(
                    bodyText
                )
            ) {

                throw new Error(
                    'There are currently no buy orders for this kit.'
                );
            }

            writeDiagnostic('log',
                '[TF2 Kit BuyOrder] Listing page summary:',
                {
                    title:
                        doc.title,
                    htmlLength:
                        html.length,
                    bodyTextLength:
                        bodyText.length
                }
            );

            throw new Error(
                'Could not find the buy-order price on the Steam listing page for ' +
                kitName
            );
        }

        const priceText =
            buyOrderMatch[1].trim();

        const parsedPrice =
            parseSteamPrice(
                priceText
            );

        if (
            !parsedPrice ||
            parsedPrice.minorUnits <= 0
        ) {

            throw new Error(
                'Could not parse Steam buy-order price "' +
                priceText +
                '" for ' +
                kitName
            );
        }

        writeDiagnostic('log',
            '[TF2 Kit BuyOrder] Listing-page buy order:',
            kitName,
            parsedPrice.formatted
        );

        return parsedPrice;
    }

    async function getFinishedKitHighestBuyOrder(
        kitName, options = {}
    ) {

        const cleanMatch =
            String(kitName || '')
                .replace(/\u00A0/g, ' ')
                .replace(/\s+/g, ' ')
                .trim()
                .match(
                    /((?:Specialized|Professional)\s+Killstreak\s+.+?\s+Kit)(?:\s+Fabricator\b)?/i
                );

        if (cleanMatch) {
            kitName =
                cleanMatch[1].trim();
        }

        const cached =
            buyOrderCache.get(kitName);

        if (
            cached &&
            Date.now() - cached.time <
                BUY_ORDER_CACHE_TIME
        ) {
            return cached.result;
        }

        const listingURL =
            buildFinishedKitMarketURL(
                kitName
            );

        /*
         * Force English for the background lookup so the parser can
         * reliably match Steam's "requests to buy at ... or lower" text.
         * The visible button still links to the normal listing URL.
         */
        const listingFetchURL =
            listingURL +
            (listingURL.includes('?') ? '&' : '?') +
            'l=english';

        writeDiagnostic('log',
            '[TF2 Kit BuyOrder] Loading finished-kit listing:',
            listingFetchURL
        );

        const html =
            await requestHTML(
                listingFetchURL, options
            );

        const orderContext =
            extractListingOrderContext(html);

        let highestBuyOrder;

        if (!orderContext.itemNameID) {

            writeDiagnostic('warn',
                '[TF2 Kit BuyOrder] Listing did not expose item_nameid; using legacy page-text fallback.'
            );

            highestBuyOrder =
                extractHighestBuyOrderFromListingHTML(
                    html,
                    kitName
                );

        } else {

            const histogramURL =
                buildOrderHistogramURL(
                    orderContext
                );

            writeDiagnostic('log',
                '[TF2 Kit BuyOrder] Loading order book:',
                {
                    itemNameID:
                        orderContext.itemNameID,
                    countryCode:
                        orderContext.countryCode,
                    currencyID:
                        orderContext.currencyID
                }
            );

            try {

                const histogram =
                    await requestJSON(
                        histogramURL,
                        listingURL, options
                    );

                highestBuyOrder =
                    extractHighestBuyOrderFromHistogram(
                        histogram,
                        kitName
                    );

            } catch (histogramError) {

                if (histogramError.name === 'AbortError' || options.signal?.aborted) throw histogramError;
                if (histogramError.noBuyOrders)
                    throw histogramError;

                writeDiagnostic('warn',
                    '[TF2 Kit BuyOrder] Structured order-book lookup failed; trying legacy page-text fallback:',
                    histogramError
                );

                try {

                    highestBuyOrder =
                        extractHighestBuyOrderFromListingHTML(
                            html,
                            kitName
                        );

                } catch (fallbackError) {

                    throw new Error(
                        histogramError.message +
                        ' Legacy fallback also failed: ' +
                        fallbackError.message
                    );
                }
            }
        }

        /*
         * The listing page gives us the current highest buy order.
         * For the button, show the amount remaining after a flat
         * 15% Steam selling tax:
         *
         * net = highest buy order × (1 - 0.15)
         */
        const instaSellMinorUnits =
            Math.round(
                highestBuyOrder.minorUnits *
                (1 - STEAM_SELL_TAX_RATE)
            );

        const result = {
            grossMinorUnits:
                highestBuyOrder.minorUnits,

            instaSellMinorUnits:
                instaSellMinorUnits,

            format:
                highestBuyOrder.format,

            highestBuyOrderFormatted:
                highestBuyOrder.formatted,

            formattedPrice:
                formatSteamCurrency(
                    instaSellMinorUnits,
                    highestBuyOrder.format
                ),

            listingURL:
                listingURL
        };

        buyOrderCache.set(
            kitName,
            {
                time: Date.now(),
                result: result
            }
        );

        writeDiagnostic('log',
            '[TF2 Kit BuyOrder] Highest buy order:',
            kitName,
            result.highestBuyOrderFormatted,
            '| after 15% tax:',
            result.formattedPrice
        );

        return result;
    }

    // ============================================================
    // PUBLISHED PRICE PRIORITY + STEAM INVENTORY SETTINGS
    // ============================================================
