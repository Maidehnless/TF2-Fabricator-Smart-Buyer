    function parseSteamPrice(priceText) {

        if (!priceText)
            return null;

        const raw =
            String(priceText)
                .replace(/\u00A0/g, ' ')
                .trim();

        const firstDigit =
            raw.search(/\d/);

        if (firstDigit === -1)
            return null;

        let lastDigit = -1;

        for (
            let i = raw.length - 1;
            i >= 0;
            i--
        ) {
            if (/\d/.test(raw[i])) {
                lastDigit = i;
                break;
            }
        }

        if (lastDigit === -1)
            return null;

        /*
         * Preserve whatever currency Steam returned rather than
         * assuming AUD.
         *
         * Examples:
         *
         * A$ 1.91  -> prefix "A$"
         * $1.91    -> prefix "$"
         * 1,91€    -> suffix "€"
         * ¥120     -> prefix "¥"
         */
        const prefix =
            raw
                .substring(0, firstDigit)
                .replace(/\s+/g, '');

        const suffix =
            raw
                .substring(lastDigit + 1)
                .replace(/\s+/g, '');

        const numericText =
            raw
                .substring(
                    firstDigit,
                    lastDigit + 1
                )
                .replace(/\s+/g, '');

        const lastDot =
            numericText.lastIndexOf('.');

        const lastComma =
            numericText.lastIndexOf(',');

        let decimalSeparator = null;

        if (
            lastDot !== -1 &&
            lastComma !== -1
        ) {

            /*
             * If both separators exist, the final separator is
             * Steam's decimal separator:
             *
             * 1,234.56
             * 1.234,56
             */
            decimalSeparator =
                lastDot > lastComma
                    ? '.'
                    : ',';

        } else {

            const separator =
                lastDot !== -1
                    ? '.'
                    : (
                        lastComma !== -1
                            ? ','
                            : null
                    );

            if (separator) {

                const separatorIndex =
                    numericText.lastIndexOf(
                        separator
                    );

                const digitsAfter =
                    numericText.length -
                    separatorIndex -
                    1;

                /*
                 * Steam currencies normally use 0, 2, or in a few
                 * cases 3 decimal places. Treat a trailing group of
                 * 1-3 digits as the decimal part.
                 *
                 * This keeps the script usable across Steam wallet
                 * currencies instead of assuming two AUD decimals.
                 */
                if (
                    digitsAfter >= 1 &&
                    digitsAfter <= 3
                ) {
                    decimalSeparator =
                        separator;
                }
            }
        }

        let decimals = 0;
        let wholeText = numericText;
        let fractionText = '';

        if (decimalSeparator) {

            const decimalIndex =
                numericText.lastIndexOf(
                    decimalSeparator
                );

            decimals =
                numericText.length -
                decimalIndex -
                1;

            wholeText =
                numericText
                    .substring(
                        0,
                        decimalIndex
                    )
                    .replace(/[.,]/g, '');

            fractionText =
                numericText
                    .substring(
                        decimalIndex + 1
                    )
                    .replace(/[.,]/g, '');

        } else {

            wholeText =
                numericText
                    .replace(/[.,]/g, '');
        }

        if (!wholeText)
            wholeText = '0';

        const whole =
            parseInt(
                wholeText,
                10
            );

        if (!Number.isFinite(whole))
            return null;

        const scale =
            Math.pow(
                10,
                decimals
            );

        let fraction = 0;

        if (decimals > 0) {

            fraction =
                parseInt(
                    fractionText
                        .padEnd(
                            decimals,
                            '0'
                        )
                        .substring(
                            0,
                            decimals
                        ),
                    10
                );

            if (!Number.isFinite(fraction))
                fraction = 0;
        }

        const minorUnits =
            (whole * scale) +
            fraction;

        const format = {
            prefix,
            suffix,
            decimalSeparator:
                decimalSeparator || '.',
            decimals
        };

        return {
            minorUnits,
            format,
            formatted:
                formatSteamCurrency(
                    minorUnits,
                    format
                )
        };
    }

    function formatSteamCurrency(
        minorUnits,
        format
    ) {

        if (
            !format ||
            !Number.isFinite(minorUnits)
        ) {
            return String(minorUnits);
        }

        const decimals =
            Number.isFinite(format.decimals)
                ? format.decimals
                : 2;

        const minorUnitDecimals =
            Number.isFinite(format.minorUnitDecimals)
                ? format.minorUnitDecimals
                : decimals;

        const minorUnitScale =
            Math.pow(
                10,
                minorUnitDecimals
            );

        const displayScale =
            Math.pow(
                10,
                decimals
            );

        const absoluteUnits =
            Math.abs(
                Math.round(minorUnits)
            );

        const displayUnits =
            Math.round(
                absoluteUnits *
                displayScale /
                minorUnitScale
            );

        const whole =
            Math.floor(
                displayUnits / displayScale
            );

        const fraction =
            decimals > 0
                ? String(
                    displayUnits % displayScale
                ).padStart(
                    decimals,
                    '0'
                )
                : '';

        const numberText =
            (
                minorUnits < 0
                    ? '-'
                    : ''
            ) +
            String(whole) +
            (
                decimals > 0
                    ? (
                        format.decimalSeparator +
                        fraction
                    )
                    : ''
            );

        return (
            (format.prefix || '') +
            numberText +
            (format.suffix || '')
        );
    }

    /*
     * Compatibility helper for any debugging code that still wants
     * an approximate two-decimal numeric representation.
     *
     * Displayed prices do NOT use this function.
     */
    function parseSteamPriceToCents(priceText) {

        const parsed =
            parseSteamPrice(
                priceText
            );

        if (!parsed)
            return null;

        const scale =
            Math.pow(
                10,
                parsed.format.decimals
            );

        return Math.round(
            (
                parsed.minorUnits /
                scale
            ) *
            100
        );
    }

    // ============================================================
    // TAMPERMONKEY REQUEST
    // ============================================================
