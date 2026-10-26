    // Steam's Market can return either its legacy JSON envelope or a modern
    // HTML document carrying inert JSON state. Never evaluate page JavaScript.
    function decodeSteamMarketResponse(text) {
        const raw=String(text || '').trim();
        if (!raw) throw Error('Steam returned an empty Market response');
        if (raw.startsWith('{') || raw.startsWith('[') || raw === 'null') {
            try { return JSON.parse(raw); }
            catch (_) { throw Error('Steam returned malformed Market JSON'); }
        }
        const doc=new DOMParser().parseFromString(raw,'text/html');
        const state=doc.querySelector('script#valve-ssr-data[type="application/json"], script#valve-ssr-data');
        if (!state) throw Error('Steam returned HTML without embedded Market data' +
            (doc.title ? ' (' + doc.title.slice(0,80) + ')' : ''));
        try {
            const ssr=JSON.parse(state.textContent);
            const rawQueries=ssr?.renderContext?.queryData;
            const queries=typeof rawQueries==='string' ? JSON.parse(rawQueries) : rawQueries;
            if (!Array.isArray(queries?.queries)) throw Error('missing query cache');
            return {marketFormat:'steam-ssr',queries:queries.queries};
        } catch(error) { throw Error('Steam embedded Market data could not be decoded: ' + error.message); }
    }

    // All Market adapters share pacing, deduplication, short caching and a cooldown.
    function requestHTML(url, options = {}) {
        return marketClient.get('html:' + url, () => requestHTMLUncached(url), options);
    }
    function requestJSON(url, referer = null, options = {}) {
        return marketClient.get('json:' + url, async () => { const data = await requestJSONUncached(url, referer); if(data && typeof data === 'object') quoteReceivedAt.set(data,Date.now()); return data; }, options);
    }
    function requestHTMLUncached(url) {

        return new Promise(
            (resolve, reject) => {

                GM_xmlhttpRequest({

                    method: 'GET',

                    url: url,

                    timeout: 15000,

                    headers: {
                        'Accept':
                            'text/html,application/xhtml+xml'
                    },

                    anonymous: false,

                    onload: function (response) {

                        writeDiagnostic('log',
                            '[TF2 MultiBuy] HTTP status:',
                            response.status
                        );

                        if (
                            response.status < 200 ||
                            response.status >= 300
                        ) {

                            reject(
                                new Error(
                                    'Steam returned HTTP ' +
                                    response.status
                                )
                            );

                            return;
                        }

                        if (!response.responseText) {

                            reject(
                                new Error(
                                    'Steam returned an empty page.'
                                )
                            );

                            return;
                        }

                        resolve(
                            response.responseText
                        );
                    },

                    onerror: function (error) {

                        writeDiagnostic('warn',
                            '[TF2 MultiBuy] Network error:',
                            error
                        );

                        reject(
                            new Error(
                                'Tampermonkey request failed.'
                            )
                        );
                    },

                    ontimeout: function () {

                        reject(
                            new Error(
                                'Steam request timed out.'
                            )
                        );
                    }

                });

            }
        );
    }

    function requestJSONUncached(url, referer = null) {

        return new Promise(
            (resolve, reject) => {

                const headers = {
                    'Accept':
                        'application/json,text/javascript,*/*;q=0.01',
                    'X-Requested-With':
                        'XMLHttpRequest'
                };

                if (referer)
                    headers['Referer'] = referer;

                GM_xmlhttpRequest({

                    method: 'GET',

                    url: url,

                    timeout: 15000,

                    headers: headers,

                    anonymous: false,

                    onload: function (response) {

                        writeDiagnostic('log',
                            '[TF2 Market JSON/SSR] HTTP status:',
                            response.status
                        );

                        if (
                            response.status < 200 ||
                            response.status >= 300
                        ) {

                            reject(
                                new Error(
                                    'Steam returned HTTP ' +
                                    response.status
                                )
                            );

                            return;
                        }

                        try {

                            const data =
                                response.response &&
                                typeof response.response === 'object'
                                    ? response.response
                                    : decodeSteamMarketResponse(response.responseText);

                            resolve(data);

                        } catch (error) {

                            reject(error);
                        }
                    },

                    onerror: function (error) {

                        writeDiagnostic('warn',
                            '[TF2 Kit BuyOrder] Network error:',
                            error
                        );

                        reject(
                            new Error(
                                'Tampermonkey request failed.'
                            )
                        );
                    },

                    ontimeout: function () {

                        reject(
                            new Error(
                                'Steam request timed out.'
                            )
                        );
                    }

                });
            }
        );
    }

    // ============================================================
    // READ STEAM MULTIBUY PAGE
    // ============================================================
