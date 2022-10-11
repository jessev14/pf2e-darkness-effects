const moduleID = 'pf2e-darkness-effects';
const effectCompendiumIDmap = {
    1: '1JYStHqExNLfpRxl', // dimlyLit
    0: 'uxlkHZ3L0VYLRfne' // inDarkness
};
const DARKNESS_LEVELS = {
    brightlyLit: 2,
    dimlyLit: 1,
    inDarkness: 0
};

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


Hooks.on('updateScene', async (scene, diff, options, userID) => {
    if (game.user.id !== userID) return;
    
    if (sceneDoc === canvas.scene) return updateTokens(); // Viewed scene is scene being updated. Update tokens.
    else {
        // Other scene is being updated. Prompt user to switch to that scene to update tokens. Required as lighting layer quadtree is used to determine lighting.
        //ui.notifications.info(`Switch to scene (${sceneDoc.name}) to update darkness effects.`);
        const hk = Hooks.on('canvasReady', async newCanvas => {
            if (game.user.id !== userID) return;
            if (newCanvas !== sceneDoc) return;

            await updateTokens();

            Hooks.off('canvasReady', hk);
        });
    }


    async function updateTokens() {
        for (const token of sceneDoc.tokens) await setEffect(token);
    }
});

Hooks.on('createToken', async (tokenDoc, options, userID) => {
    if (game.user.id !== userID) return;

    await setEffect(tokenDoc);
});

Hooks.on('updateToken', async (tokenDoc, diff, options, userID) => {
    if (game.user.id !== userID) return;
    if (!('x' in diff) && !('y' in diff) && !('dim' in diff.light) && !('bright' in diff.light)) return;

    // Wait for additional updates to this token.
    let additionalUpdate = false;
    const hk = Hooks.on('preUpdateToken', (innerTokenDoc, diff, options, userID) => {
        if (innerTokenDoc !== tokenDoc) return;

        additionalUpdate = true;
    });
    await delay(1000);
    Hooks.off('preUpdateToken', hk);
    if (additionalUpdate) return;

    await setEffect(tokenDoc);

    // If token has light source, check darkness levels of other tokens contained by light polygon.
    for (const otherTokenDoc of tokenDoc.parent.tokens) {
        if (otherTokenDoc === tokenDoc) continue;

        const { x, y } = otherTokenDoc.object.getCenter(otherTokenDoc.x, otherTokenDoc.y);
        if (!tokenDoc.object.light.los?.contains(x, y)) continue;

        await setEffect(otherTokenDoc);
    }
});

Hooks.on('deleteToken', async (tokenDoc, options, userID) => {
    if (game.user.id !== userID) return;

    // Wait for additional token deletions.
    let additionalUpdate = false;
    const hk = Hooks.on('preDeleteToken', (innerTokenDoc, options, userID) => {
        additionalUpdate = true;
    });
    await delay(1000);
    Hooks.off('preDeleteToken', hk);
    if (additionalUpdate) return;

    for (const token of tokenDoc.parent.tokens) await setEffect(token);    
});

Hooks.on('createAmbientLight', async (lightDoc, options, userID) => {
    if (game.user.id !== userID) return;
    
    // Wait for this light to be included in light layer quadtree
    await delay(1000);
    for (const tokenDoc of lightDoc.parent.tokens) await setEffect(tokenDoc);
});

Hooks.on('updateAmbientLight', async (lightDoc, diff, options, userID) => {
    if (game.user.id !== userID) return;

    for (const tokenDoc of lightDoc.parent.tokens) await setEffect(tokenDoc);
});

Hooks.on('deleteAmbientLight', async (lightDoc, options, userID) => {
    if (game.user.id !== userID) return;

    for (const tokenDoc of lightDoc.parent.tokens) await setEffect(tokenDoc);
});


async function setEffect(tokenDoc) {
    // Wait for ruler-based movement to complete.
    while (canvas.controls.ruler._state) await delay(1000);

    const { actor } = tokenDoc;

    const shouldSceneCheckDarkness = checkDarkness(tokenDoc.parent);
    if (!shouldSceneCheckDarkness) {
        // If darkness should not be checked in this scene, remove all darkness effects.
        const darknessEffectIDs = actor.itemTypes.effect.filter(e => e.flags[moduleID]).map(e => e.id);
        await actor.deleteEmbeddedDocuments('Item', darknessEffectIDs);
        await actor.unsetFlag(moduleID, 'darknessLevel');
        return;
    }

    if (!tokenDoc.object) return;

    // Get current darkness level and compare to previous level.
    const darknessLevel = getDarknessLevel(tokenDoc.object);
    const previousDarknessLevel = actor.getFlag(moduleID, 'darknessLevel');
    if (previousDarknessLevel === darknessLevel) return;
    
    // Save new darkness level as flag on actor.
    await actor.setFlag(moduleID, 'darknessLevel', darknessLevel);

    // Remove pre-existing darkness effects.
    const darknessEffectIDs = actor.itemTypes.effect.filter(e => e.flags[moduleID]).map(e => e.id);
    await actor.deleteEmbeddedDocuments('Item', darknessEffectIDs);

    // Add new darkness effect from override if present; from compendium if not.
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
        createData.flags[moduleID] = {
            [effect]: true
        };
        await actor.createEmbeddedDocuments('Item', [createData]);
    }

    // Create chat message if enabled.
    const chatMessageAlertSetting = game.settings.get(moduleID, 'chatMessageAlert');
    if (chatMessageAlertSetting === 'off') return;

    let content = `${tokenDoc.name} enters `;
    if (darknessLevel === DARKNESS_LEVELS['dimlyLit']) content += 'dim light.';
    else if (darknessLevel === DARKNESS_LEVELS['inDarkness']) content += 'darkness.';
    else content += 'bright light.';

    const whisper = [];
    const tokenHidden = tokenDoc.hidden || actor.itemTypes.condition.includes('Concealed') || actor.itemTypes.condition.includes('Hidden');
    if (chatMessageAlertSetting === 'gm' || tokenHidden) whisper.push(...game.users.filter(u => u.isGM).map(u => u.id));
    else if (chatMessageAlertSetting === 'players') whisper.push(...game.users.filter(u => !u.isGM).map(u => u.id));

    await ChatMessage.create({
        content,
        whisper
    });
}

function getDarknessLevel(tokenObj) {
    // If token has bright radius, then token is brightly lit.
    if (tokenObj.brightRadius) return DARKNESS_LEVELS['brightlyLit'];
    // If token has dim radius (but no bright radius), then token is dimly lit.
    if (tokenObj.dimRadius) return DARKNESS_LEVELS['dimlyLit'];

    // Use lighting layer quadtree to get light objects that collide with token bounds.
    // While searching, filter out lights if the light's polygon does not contain token.
    const { x, y } = tokenObj.getCenter(tokenObj.x, tokenObj.y);
    const lightPolygonFilter = (o, rect) => {
        const light = o.t;
        if (!light.emitsLight) return false;

        const { los } = light.source;
        const tokenInLightPolygon = los.contains(x, y);
        if (tokenInLightPolygon) {
            // If token is within light polygon, determine if token is within light's bright radius.
            const tokenInBrightRadius = inBrightRadius(tokenObj, light);
            // Flag the light to be caught later.
            light[moduleID] = {
                brightlyLighting: tokenInBrightRadius
            };

            return true;
        }

        return false;
    };
    const lights = canvas.lighting.quadtree.getObjects(tokenObj.bounds, { collisionTest: lightPolygonFilter });
    // Also find light sources from other tokens.
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

    let darknessLevel = DARKNESS_LEVELS['brightlyLit']; // First assume token is brightly lit by a light source.
    if (!lights.size) darknessLevel = DARKNESS_LEVELS['inDarkness']; // If no lights found, token must be in darkness.
    else if (!lights.some(l => l[moduleID]?.brightlyLighting)) darknessLevel = DARKNESS_LEVELS['dimlyLit']; // If any lights were found, but token was not in any bright radius, it must be dimly lit.

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
