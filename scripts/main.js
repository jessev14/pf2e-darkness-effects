const moduleID = 'pf2e-darkness-effects';
const effectCompendiumIDmap = {
    1: '1JYStHqExNLfpRxl',
    0: 'uxlkHZ3L0VYLRfne'
};
const DARKNESS_LEVELS = {
    brightlyLit: 2,
    dimlyLit: 1,
    inDarkness: 0
};
let socket;

const logg = x => console.log(x);

const checkDarkness = scene => {
    const { tokenVision, globalLight, darkness, globalLightThreshold } = scene;
    const thresholdEnabled = typeof(globalLightThreshold) === 'number';
    if (thresholdEnabled) return darkness > globalLightThreshold;
    return !globalLight || tokenVision;
}

const delay = async (ms = 1000) => {
    await new Promise(resolve => {
        setTimeout(resolve, ms);
    });
}


Hooks.once('init', () => {
    game.settings.register(moduleID, 'chatMessageAlert', {
        name: 'Chat Message Alerts',
        scope: 'world',
        config: true,
        type: String,
        choices: {
            off: "Off",
            players: "Players",
            both: "GMs + Players",
            gm: "GMs"
        },
        default: 'off'
    });

    game.settings.register(moduleID, effectCompendiumIDmap[DARKNESS_LEVELS['dimlyLit']], {
        name: '"Dimly Lit" Effect Override Item ID',
        hint: 'Enter the ID of an effect here to use instead of the bundled "Dimly Lit" effect.',
        scope: 'client',
        config: true,
        type: String,
        default: ''
    });

    game.settings.register(moduleID, effectCompendiumIDmap[DARKNESS_LEVELS['inDarkness']], {
        name: '"In Darkness" Effect Override Item ID',
        hint: 'Enter the ID of an effect here to use instead of the bundled "In Darkness" effect.',
        scope: 'client',
        config: true,
        type: String,
        default: ''
    });
});

Hooks.once('socketlib.ready', () => {
    socket = socketlib.registerModule(moduleID);
    socket.register('setEffect', setEffect);
});


Hooks.on('updateScene', async (scene, diff, options, userID) => {
    if (game.user.id !== userID) return;
    
    if (scene === canvas.scene) return updateTokens();
    else {
        const hk = Hooks.on('canvasReady', async newCanvas => {
            if (game.user.id !== userID) return;
            if (newCanvas !== scene) return;

            await updateTokens();

            Hooks.off('canvasReady', hk);
        });
    }


    async function updateTokens() {
        for (const tokenDoc of canvas.scene.tokens) await socket.executeAsGM('setEffect', tokenDoc.uuid);
    }
});

Hooks.on('createToken', async (tokenDoc, options, userID) => {
    if (game.user.id !== userID) return;

    await socket.executeAsGM('setEffect', tokenDoc.uuid);
});

Hooks.on('updateToken', async (tokenDoc, diff, options, userID) => {
    if (game.user.id !== userID) return;
    if (!('x' in diff) && !('y' in diff) && !('dim' in (diff.light || {})) && !('bright' in (diff.light || {}))) return;

    let additionalUpdate = false;
    const hk = Hooks.on('preUpdateToken', (innerTokenDoc, diff, options, userID) => {
        if (innerTokenDoc !== tokenDoc) return;

        additionalUpdate = true;
    });
    await delay(1000);
    Hooks.off('preUpdateToken', hk);
    if (additionalUpdate) return;

    while (canvas.controls.ruler._state) await delay(1000);

    for (const token of tokenDoc.parent.tokens) await socket.executeAsGM('setEffect', token.uuid);
});

Hooks.on('deleteToken', async (tokenDoc, options, userID) => {
    if (game.user.id !== userID) return;

    let additionalUpdate = false;
    const hk = Hooks.on('preDeleteToken', (innerTokenDoc, options, userID) => {
        additionalUpdate = true;
    });
    await delay(1000);
    Hooks.off('preDeleteToken', hk);
    if (additionalUpdate) return;

    for (const token of tokenDoc.parent.tokens) await socket.executeAsGM('setEffect', token.uuid);
});

Hooks.on('preUpdateItem', (itemDoc, diff, options, userID) => {
    if (!'equipped' in (diff.system || {})) return;

    const hk = Hooks.on('updateItem', async (innerItemDoc, innerDiff, innerOptions, innerUserID) => {
        if (innerUserID !== userID) return;

        await delay(1000);
        for (const tokenDoc of itemDoc.parent.getActiveTokens()[0]?.document.parent.tokens || []) await socket.executeAsGM('setEffect', tokenDoc.uuid);
        Hooks.off('updateIte', hk);
    });

});

Hooks.on('createAmbientLight', async (lightDoc, options, userID) => {
    if (game.user.id !== userID) return;
    
    await delay(1000);
    for (const tokenDoc of lightDoc.parent.tokens) await socket.executeAsGM('setEffect', tokenDoc.uuid);
});

Hooks.on('updateAmbientLight', async (lightDoc, diff, options, userID) => {
    if (game.user.id !== userID) return;

    for (const tokenDoc of lightDoc.parent.tokens) await socket.executeAsGM('setEffect', tokenDoc.uuid);
});

Hooks.on('deleteAmbientLight', async (lightDoc, options, userID) => {
    if (game.user.id !== userID) return;

    for (const tokenDoc of lightDoc.parent.tokens) await socket.executeAsGM('setEffect', tokenDoc.uuid);
});


async function setEffect(tokenDocUUID) {

    const tokenDoc = await fromUuid(tokenDocUUID);
    if (!tokenDoc) return;

    const { actor } = tokenDoc;

    const shouldSceneCheckDarkness = checkDarkness(tokenDoc.parent);
    if (!shouldSceneCheckDarkness) {
        const darknessEffectIDs = actor.itemTypes.effect.filter(e => e.flags[moduleID]).map(e => e.id);
        if (darknessEffectIDs) {
            await actor.deleteEmbeddedDocuments('Item', darknessEffectIDs);
        }
        await actor.unsetFlag(moduleID, 'darknessLevel');
        return;
    }

    if (!tokenDoc.object) return;

    const darknessLevel = getDarknessLevel(tokenDoc.object);
    const previousDarknessLevel = actor.getFlag(moduleID, 'darknessLevel');
    if (previousDarknessLevel === darknessLevel) return;

    await actor.setFlag(moduleID, 'darknessLevel', darknessLevel);

    const darknessEffectIDs = actor.itemTypes.effect.filter(e => e.flags[moduleID]).map(e => e.id);
    if (darknessEffectIDs) {
        await actor.deleteEmbeddedDocuments('Item', darknessEffectIDs);
    }

    let effect, override;
    try {
        override = game.settings.get(moduleID, effectCompendiumIDmap[darknessLevel]);
    } catch (e) { }

    if (override) effect = game.items.get(override);
    else {
        const effectID = effectCompendiumIDmap[darknessLevel];
        const compendium = game.packs.get(`${moduleID}.darkness-effects`);
        effect = await compendium.getDocument(effectID);
    }

    if (effect) {
        const createData = effect.toObject();
        createData.flags = {
            [moduleID]: {
                darknessLevel: darknessLevel
            },
            autoanimations: {
                version: 5,
                isEnabled: false,
                macro: {
                    enabled: false
                }
            }
        };
        await actor.createEmbeddedDocuments('Item', [createData]);
    }

    const chatMessageAlertSetting = game.settings.get(moduleID, 'chatMessageAlert');
    if (chatMessageAlertSetting === 'off') return;

    let content = `${tokenDoc.name} enters `;
    if (darknessLevel === DARKNESS_LEVELS['dimlyLit']) content += 'dim light.';
    else if (darknessLevel === DARKNESS_LEVELS['inDarkness']) content += 'darkness.';
    else content += 'bright light.';

    const whisper = [];
    const tokenHidden = tokenDoc.hidden || actor.itemTypes.condition.some(c => ['hidden', 'invisible', 'undetected'].includes(c.slug));
    if (chatMessageAlertSetting === 'gm' || tokenHidden) whisper.push(...game.users.filter(u => u.isGM).map(u => u.id));
    else if (chatMessageAlertSetting === 'players') whisper.push(...game.users.filter(u => !u.isGM).map(u => u.id));

    await ChatMessage.create({
        content,
        whisper
    });
}

function getDarknessLevel(tokenObj) {
    if (tokenObj.brightRadius) return DARKNESS_LEVELS['brightlyLit'];
    if (tokenObj.dimRadius) return DARKNESS_LEVELS['dimlyLit'];

    const { x, y } = tokenObj.getCenter(tokenObj.x, tokenObj.y);
    const lightPolygonFilter = (o, rect) => {
        const light = o.t;
        if (!light.emitsLight) return false;

        const { los } = light.source;
        const tokenInLightPolygon = los.contains(x, y);
        if (tokenInLightPolygon) {
            const tokenInBrightRadius = inBrightRadius(tokenObj, light);
            light[moduleID] = {
                brightlyLighting: tokenInBrightRadius
            };

            return true;
        }

        return false;
    };
    const lights = canvas.lighting.quadtree.getObjects(tokenObj.bounds, { collisionTest: lightPolygonFilter });
    for (const tokenDoc of tokenObj.document.parent.tokens) {
        if (tokenDoc === tokenObj.document) continue;
        if (!tokenDoc.object.emitsLight) continue;
        if (!tokenDoc.object.light.los.contains(x, y)) continue;

        const tokenInBrightRadius = inBrightRadius(tokenObj, tokenDoc.object);
        tokenDoc[moduleID] = {
            brightlyLighting: tokenInBrightRadius
        };

        lights.add(tokenDoc);
    }

    let darknessLevel = DARKNESS_LEVELS['brightlyLit'];
    if (!lights.size) darknessLevel = DARKNESS_LEVELS['inDarkness'];
    else if (!lights.some(l => l[moduleID]?.brightlyLighting)) darknessLevel = DARKNESS_LEVELS['dimlyLit'];

    return darknessLevel;
}

function inBrightRadius(tokenObj, lightSource) {
    const { x: tokenX, y: tokenY } = tokenObj.getCenter(tokenObj.x, tokenObj.y);
    const { x: lightX, y: lightY, brightRadius } = lightSource;

    const a = lightX - tokenX;
    const b = lightY - tokenY;
    const distance = Math.sqrt((a ** 2) + (b ** 2));

    return distance <= brightRadius;
}
