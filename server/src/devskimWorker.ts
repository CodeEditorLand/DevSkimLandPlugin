/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ 
 * 
 * This file contains the actual meat and potatoes of analysis.  The DevSkimWorker class does 
 * the actual work of analyzing data it was given
 * 
 * Most of the type declerations representing things like the rules used to analyze a file, and 
 * problems found in a file, are in devskimObjects.ts
 * 
 * ------------------------------------------------------------------------------------------ */
import {IConnection, Range} from 'vscode-languageserver';
import {
    computeKey, Condition, DevSkimProblem, DevskimRuleSeverity, Map, AutoFix,
    Rule, DevSkimAutoFixEdit, IDevSkimSettings,
}
    from "./devskimObjects";
import {DevSkimSuppression, DevSkimSuppressionFinding} from "./suppressions";
import {PathOperations} from "./pathOperations";
import {SourceComments} from "./comments";
import {RuleValidator} from "./ruleValidator";
import {DevSkimWorkerSettings} from "./devskimWorkerSettings";
import {RulesLoader} from "./rulesLoader";

/**
 * The bulk of the DevSkim analysis logic.  Loads rules in, exposes functions to run rules across a file
 */
export class DevSkimWorker {
    public dswSettings: DevSkimWorkerSettings = new DevSkimWorkerSettings();
    public readonly rulesDirectory: string;
    private analysisRules: Rule[];
    private tempRules: Rule[];
    private dir = require('node-dir');

    //codeActions is the object that holds all of the autofix mappings. we need to store them because
    //the CodeActions are created at a different point than the diagnostics, yet we still need to be able
    //to associate the action with the diagnostic.  So we create a mapping between them and look up the fix
    //in the map using values out of the diagnostic as a key
    //
    //We use nested Maps to store the fixes.  The key to the first map is the document URI.  This maps a 
    //specific file to a map of the fixes for that file.  The key for this second map is created in
    //the devskimObjects.ts file, in the function computeKey.  the second key is in essence a combination of
    //a diagnostic and a string represetnation of a number for a particular fix, as there may be multiple fixes associated with a single diagnostic
    //i.e. we suggest both strlcpy and strcpy_s to fix strcpy
    //
    //it's format is essentially <document URI <diagnostic + fix#>>.  We could instead have done <document <diagnostic <fix#>>>, but three deep
    //map seemed a little excessive to me.  Then again, I just wrote 3 paragraphs for how this works, so maybe I'm being too clever
    public codeActions: Map<Map<AutoFix>> = Object.create(null);

    constructor(private connection: IConnection, private dsSuppressions: DevSkimSuppression, settings?: IDevSkimSettings) {
        this.rulesDirectory = DevSkimWorkerSettings.getRulesDirectory();
        this.rulesDirectory = String.raw`C:/Users/v-dakit/DevSkimRules`; // @todo: fix this
        this.dswSettings.getSettings(settings);
    }

    public async init(): Promise<void> {
        await this.loadRules();
    }

    /**
     * Look for problems in the provided text
     *
     * @param {string} documentContents the contents of a file to analyze
     * @param {string} langID the programming language for the file
     * @param {string} documentURI the URI identifying the file
     * @returns {DevSkimProblem[]} an array of all of the issues found in the text
     */
    public analyzeText(documentContents: string, langID: string, documentURI: string): DevSkimProblem[] {
        let problems: DevSkimProblem[] = [];

        //Before we do any processing, see if the file (or its directory) are in the ignore list.  If so
        //skip doing any analysis on the file
        if (this.analysisRules && this.analysisRules.length
            && this.dswSettings && this.dswSettings.getSettings().ignoreFilesList
            && !PathOperations.ignoreFile(documentURI, this.dswSettings.getSettings().ignoreFilesList)) {

            //find out what issues are in the current document
            problems = this.runAnalysis(documentContents, langID, documentURI);

            //remove any findings from rules that have been overridden by other rules
            problems = this.processOverrides(problems);
        }
        return problems;
    }

    /**
     * Save a codeaction for a particular auto-fix to the codeActions map, so that it can be looked up when onCodeAction is called
     * and actually communicated to the VSCode engine.  Since creating a diagnostic and assigning a code action happen at different points
     * its important to be able to look up what code actions should be populated at a given time
     *
     * @param {string} documentURI the path to the document, identifying it
     * @param {number} documentVersion the current revision of the document (vs code calculates this)
     * @param range  @ToDo: update this document
     * @param {string | number} diagnosticCode the diagnostic a fix is associated with
     * @param {DevSkimAutoFixEdit} fix the actual data about the fix being applied (location, name, action, etc.)
     * @param {string} ruleID an identifier for the rule that was triggered
     * @returns {void}
     */
    public recordCodeAction(documentURI: string, documentVersion: number, range: Range, diagnosticCode: string | number, fix: DevSkimAutoFixEdit, ruleID: string): void
    {
        if (!fix || !ruleID) {
            return;
        }
        let fixName: string = (fix.fixName !== undefined && fix.fixName.length > 0) ? fix.fixName : `Fix this ${ruleID} problem`;
        let edits: Map<AutoFix> = this.codeActions[documentURI];
        if (!edits) {
            edits = Object.create(null);
            this.codeActions[documentURI] = edits;
        }

        let x = 0;
        //figure out how many existing fixes are associated with a given diagnostic by checking if it exists, and incrementing until it doesn't
        while (edits[computeKey(range, diagnosticCode) + x.toString(10)]) {
            x++;
        }

        //create a new mapping, using as the key the diagnostic the fix is associated with and a number representing whether this is the 1st fix
        //to associate with that diagnostic, 2nd, 3rd, and so on.  This lets us map multiple fixes to one diagnostic while providing an easy way
        //to iterate.  we could have instead made this a three nested map <file<diagnostic<fix#>>> but this achieves the same thing 
        edits[computeKey(range, diagnosticCode) + x.toString(10)] = {
            label: fixName,
            documentVersion: documentVersion,
            ruleId: ruleID,
            edit: fix,
        };
    }

    /**
     * Reload the rules from the file system.  Since this right now is just a proxy for loadRules this *could* have been achieved by
     * exposing loadRules as public.  I chose not to, as eventually it might make sense here to check if an analysis is actively running
     * and hold off until it is complete.  I don't forsee that being an issue when analyzing an indivudal file (it's fast enoguh a race condition
     * should exist with reloading rules), but might be if doing a full analysis of a lot of files.  So in anticipation of that, I broke this
     * into its own function so such a check could be added.
     */
    public refreshAnalysisRules(): void {
        this.loadRules();
    }

    private async loadRules(): Promise<void> {
       const loader = new RulesLoader(this.connection, true, this.rulesDirectory);
       const rules = await loader.loadRules();

        let validator = new RuleValidator(this.connection, this.rulesDirectory, this.rulesDirectory);
        this.analysisRules = await validator.validateRules(rules, this.dswSettings.getSettings().validateRulesFiles);
    }

    /**
     * recursively load all of the JSON files in the $userhome/.vscode/extensions/vscode-devskim/rules sub directories
     *
     * @private
     */
    private loadRulesOld(): void {
        this.tempRules = [];
        this.analysisRules = [];

        this.connection.console.log(`DevSkimWorker loadRules() starting ...`);
        this.connection.console.log(`DevSkimWorker loadRules() from ${this.rulesDirectory}`); 

        //read the rules files recursively from the file system - get all of the .json files under the rules directory.  
        //first read in the default & custom directories, as they contain the required rules (i.e. exclude the "optional" directory)
        //and then do the inverse to populate the optional rules
        this.dir.readFiles(this.rulesDirectory, {match: /.json$/},
            (err, content, file, next) => {
                if (err) {
                    this.connection.console.log(`DevSkimWorker - loadRules() - err: ${err}`);
                    throw err;
                }
                if (!file) {
                    next();
                }
                //Load the rules from files add the file path
                try {
                    const loadedRules: Rule[] = JSON.parse(content);
                    if (loadedRules) {
                        for (let rule of loadedRules) {
                            if (!rule.name) {
                                continue;
                            }
                            rule.filepath = file;
                        }
                        this.tempRules = this.tempRules.concat(loadedRules);
                        this.connection.console.log(`DevSkimWorker loadRules() so far: ${this.tempRules.length || 0}.`);
                    }
                }
                catch(e) {
                    this.connection.console.log(`DevSkimWorker - loadRules Exception: ${e.message}`);
                }
                next();
            },
            async (/* err, files */) => {
                //now that we have all of the rules objects, lets clean them up and make
                //sure they are in a format we can use.  This will overwrite any badly formed JSON files
                //with good ones so that it passes validation in the future
                let validator: RuleValidator = new RuleValidator(this.connection, this.rulesDirectory, this.rulesDirectory);
                this.analysisRules =
                    await validator.validateRules(this.tempRules, this.dswSettings.getSettings().validateRulesFiles);

                //don't need to keep this around anymore
                delete this.tempRules;
                this.connection.console.log(`DevSkimWorker loadRules() done. Rules found: ${this.analysisRules.length || 0}.`);
            });
    }

    /**
     * Low, Defense In Depth, and Informational severity rules may be turned on and off via a setting
     * prior to running an analysis, verify that the rule is enabled based on its severity and the user settings
     *
     * @public
     * @param {DevskimRuleSeverity} ruleSeverity
     * @returns {boolean}
     *
     * @memberOf DevSkimWorker
     */
    public RuleSeverityEnabled(ruleSeverity: DevskimRuleSeverity): boolean {
        return ruleSeverity == DevskimRuleSeverity.Critical ||
            ruleSeverity == DevskimRuleSeverity.Important ||
            ruleSeverity == DevskimRuleSeverity.Moderate ||
            (ruleSeverity == DevskimRuleSeverity.BestPractice &&
                this.dswSettings.getSettings().enableBestPracticeRules == true) ||
            (ruleSeverity == DevskimRuleSeverity.ManualReview &&
                this.dswSettings.getSettings().enableManualReviewRules == true);

    }

    /**
     * maps the string for severity recieved from the rules into the enum (there is inconsistencies with the case used
     * in the rules, so this is case incencitive).  We convert to the enum as we do comparisons in a number of places
     * and by using an enum we can get a transpiler error if we remove/change a label
     *
     * @public
     * @param {string} severity
     * @returns {DevskimRuleSeverity}
     *
     * @memberOf DevSkimWorker
     */
    public static MapRuleSeverity(severity: string): DevskimRuleSeverity {
        switch (severity.toLowerCase()) {
            case "critical":
                return DevskimRuleSeverity.Critical;
            case "important":
                return DevskimRuleSeverity.Important;
            case "moderate":
                return DevskimRuleSeverity.Moderate;
            case "best-practice":
                return DevskimRuleSeverity.BestPractice;
            case "manual-review":
                return DevskimRuleSeverity.ManualReview;
            default:
                return DevskimRuleSeverity.BestPractice;
        }
    }

    /**
     * the pattern type governs how we form the regex.  regex-word is wrapped in \b, string is as well, but is also escaped.
     * substring is not wrapped in \b, but is escapped, and regex/the default behavior is a vanilla regular expression
     * @param {string} regexType regex|regex-word|string|substring
     * @param {string} pattern
     * @param {string[]} modifiers modifiers to use when creating regex. can be null.  a value of "d" will be ignored if forXregExp is false
     * @param {boolean} forXregExp whether this is for the XRegExp regex engine (true) or the vanilla javascript regex engine (false)
     */
    public static MakeRegex(regexType: string, pattern: string, modifiers: string[], forXregExp: boolean): RegExp {
        //create any regex modifiers
        let regexModifer = "";
        if (modifiers != undefined && modifiers) {
            for (let mod of modifiers) {
                //xregexp implemented dotmatchall as s instead of d
                if (mod == "d") {
                    //also, Javascript doesn't support dotmatchall natively, so only use this if it will be used with XRegExp
                    if (forXregExp) {
                        regexModifer = regexModifer + "s";
                    }
                } else {
                    regexModifer = regexModifer + mod;
                }
            }
        }

        //now create a regex based on the 
        let XRegExp = require('xregexp');
        switch (regexType.toLowerCase()) {
            case 'regex-word':
                return XRegExp('\\b' + pattern + '\\b', regexModifer);
            case 'string':
                return XRegExp('\\b' + XRegExp.escape(pattern) + '\\b', regexModifer);
            case 'substring':
                return XRegExp(XRegExp.escape(pattern), regexModifer);
            default:
                return XRegExp(pattern, regexModifer);
        }
    }

    /**
     * Perform the actual analysis of the text, using the provided rules
     *
     * @param {string} documentContents the full text to analyze
     * @param {string} langID the programming language for the text
     * @param {string} documentURI URI identifying the document
     * @returns {DevSkimProblem[]} all of the issues identified in the analysis
     */
    private runAnalysis(documentContents: string, langID: string, documentURI: string): DevSkimProblem[] {
        let problems: DevSkimProblem[] = [];
        let XRegExp = require('xregexp');

        //iterate over all of the rules, and then all of the patterns within a rule looking for a match.
        for (let rule of this.analysisRules) {
            const ruleSeverity: DevskimRuleSeverity = DevSkimWorker.MapRuleSeverity(rule.severity);
            //if the rule doesn't apply to whatever language we are analyzing (C++, Java, etc.) or we aren't processing
            //that particular severity skip the rest
            if (this.dswSettings.getSettings().ignoreRulesList.indexOf(rule.id) == -1 &&  /*check to see if this is a rule the user asked to ignore */
                DevSkimWorker.AppliesToLangOrFile(langID, rule.appliesTo, documentURI) &&
                this.RuleSeverityEnabled(ruleSeverity)) {
                for (let patternIndex = 0; patternIndex < rule.patterns.length; patternIndex++) {
                    let modifiers: string[] = (rule.patterns[patternIndex].modifiers != undefined && rule.patterns[patternIndex].modifiers.length > 0) ?
                        rule.patterns[patternIndex].modifiers.concat(["g"]) : ["g"];

                    const matchPattern: RegExp = DevSkimWorker.MakeRegex(rule.patterns[patternIndex].type, rule.patterns[patternIndex].pattern, modifiers, true);

                    //go through all of the text looking for a match with the given pattern
                    let matchPosition = 0;
                    let match = XRegExp.exec(documentContents, matchPattern, matchPosition);
                    while (match) {
                        //if the rule doesn't contain any conditions, set it to an empty array to make logic later easier
                        if (!rule.conditions) {
                            rule.conditions = [];
                        }

                        //check to see if this finding has either been suppressed or reviewed (for manual-review rules)
                        //the suppressionFinding object contains a flag if the finding has been suppressed as well as
                        //range info for the ruleID in the suppression text so that hover text can be added describing
                        //the finding that was suppress
                        let suppressionFinding: DevSkimSuppressionFinding = DevSkimSuppression.isFindingCommented(match.index, documentContents, rule.id, ruleSeverity);

                        //calculate what line we are on by grabbing the text before the match & counting the newlines in it
                        let lineStart: number = DevSkimWorker.GetLineNumber(documentContents, match.index);
                        let newlineIndex: number = (lineStart == 0) ? -1 : documentContents.substr(0, match.index).lastIndexOf("\n");
                        let columnStart: number = match.index - newlineIndex - 1;

                        //since a match may span lines (someone who broke a long function invocation into multiple lines for example)
                        //it's necessary to see if there are any newlines WITHIN the match so that we get the line the match ends on,
                        //not just the line it starts on.  Also, we use the substring for the match later when making fixes
                        let replacementSource: string = documentContents.substr(match.index, match[0].length);
                        let lineEnd: number = DevSkimWorker.GetLineNumber(replacementSource, replacementSource.length) + lineStart;

                        let columnEnd = (lineStart == lineEnd) ?
                            columnStart + match[0].length :
                            match[0].length - documentContents.substr(match.index).indexOf("\n") - 1;

                        let range: Range = Range.create(lineStart, columnStart, lineEnd, columnEnd);

                        //look for the suppression comment for that finding
                        if (!suppressionFinding.showFinding &&
                            DevSkimWorker.MatchIsInScope(langID, documentContents.substr(0, match.index), newlineIndex, rule.patterns[patternIndex].scopes) &&
                            DevSkimWorker.MatchesConditions(rule.conditions, documentContents, range, langID)) {

                            //add in any fixes
                            let problem: DevSkimProblem = DevSkimWorker.MakeProblem(rule, DevSkimWorker.MapRuleSeverity(rule.severity), range);
                            problem.fixes = problem.fixes.concat(DevSkimWorker.MakeFixes(rule, replacementSource, range));
                            problem.fixes = problem.fixes.concat(this.dsSuppressions.createActions(rule.id, documentContents, match.index, lineStart, langID, ruleSeverity));

                            problems.push(problem);
                        }
                        //throw a pop up if there is a review/suppression comment with the rule id, so that people can figure out what was
                        //suppressed/reviewed
                        else if (suppressionFinding.ruleColumn > 0) {
                            //highlight suppression finding for context
                            //this will look
                            let suppressionRange: Range = Range.create(lineStart, columnStart + suppressionFinding.ruleColumn, lineStart, columnStart + suppressionFinding.ruleColumn + rule.id.length);
                            let problem: DevSkimProblem = DevSkimWorker.MakeProblem(rule, DevskimRuleSeverity.WarningInfo, suppressionRange, range);

                            problems.push(problem);

                        }
                        //advance the location we are searching in the line
                        matchPosition = match.index + match[0].length;
                        match = XRegExp.exec(documentContents, matchPattern, matchPosition);
                    }
                }
            }
        }
        return problems;
    }

    /**
     * Check to see if the finding occurs within the scope expected
     * see scope param for details
     *
     * @public
     * @param {string} langID
     * @param {string} docContentsToFinding
     * @param {number} newlineIndex
     * @param {string} scopes values are code (finding should only occur in code), comment (finding should only occur code comments), or all (finding occurs anywhere)
     * @returns {boolean}
     * @memberof DevSkimWorker
     */
    public static MatchIsInScope(langID: string, docContentsToFinding: string, newlineIndex: number, scopes: string[]): boolean {
        if (scopes.indexOf("all") > -1)
            return true;

        let findingInComment: boolean = SourceComments.IsFindingInComment(langID, docContentsToFinding, newlineIndex);

        for (let scope of scopes) {
            if ((scope == "code" && !findingInComment) || (scope == "comment" && findingInComment))
                return true;
        }
        return false;
    }

    /**
     * There are two conditions where this function gets called.  The first is to mark the code a rule triggered on and
     * in that case the rule, the severity of that rule, and the range of code for a specific finding found by that rule are
     * passed in.  suppressedFindingRange is ignored
     *
     * The second instance is when decorating the ruleID in a suppression or review comment.  e.g.:
     *     //DevSkim ignore: DS123456 or //DevSkim reviewed:DS123456
     * DevSkim will create a problem to mark the DS123456 so that when moused over so other people looking through the code
     * know what was suppressed or reviewed.  In this instance we still pass in the rule.  a Rule severity of warningInfo should
     * be passed in for warningLevel.  problemRange should be the range of the "DSXXXXXX" text that should get the information squiggle
     * and suppressedFindingRange should be the range of the finding that was suppressed or reviewed by the comment.  This last
     * is important, as we need to save that info for later to cover overrides that also should be suppressed
     * @param {Rule} rule
     * @param {DevskimRuleSeverity} warningLevel
     * @param {Range} problemRange
     * @param {Range} [suppressedFindingRange]
     */
    public static MakeProblem(rule: Rule, warningLevel: DevskimRuleSeverity, problemRange: Range, suppressedFindingRange?: Range): DevSkimProblem {
        let problem: DevSkimProblem = new DevSkimProblem(rule.description, rule.name,
            rule.id, warningLevel, rule.recommendation, rule.ruleInfo, problemRange);

        if (suppressedFindingRange) {
            problem.suppressedFindingRange = suppressedFindingRange;
        }

        if (rule.overrides && rule.overrides.length > 0) {
            problem.overrides = rule.overrides;
        }

        return problem;
    }

    /**
     *
     * @param {Condition[]} conditions the condition objects we are checking for
     * @param {string} documentContents the document we are finding the conditions in
     * @param {Range} findingRange the location of the finding we are looking for more conditions around
     * @param {string} langID the language we are working in
     */
    public static MatchesConditions(conditions: Condition[], documentContents: string, findingRange: Range, langID: string): boolean {
        if (conditions != undefined && conditions && conditions.length != 0) {
            let regionRegex: RegExp = /finding-region\((-*\d+),(-*\d+)\)/;
            let XRegExp = require('xregexp');

            for (let condition of conditions) {
                if (condition.negateFinding == undefined) {
                    condition.negateFinding = false;
                }

                let modifiers: string[] = (condition.pattern.modifiers != undefined && condition.pattern.modifiers.length > 0) ?
                    condition.pattern.modifiers.concat(["g"]) : ["g"];

                let conditionRegex: RegExp = DevSkimWorker.MakeRegex(condition.pattern.type, condition.pattern.pattern, modifiers, true);

                let startPos: number = findingRange.start.line;
                let endPos: number = findingRange.end.line;

                //calculate where to look for the condition.  finding-only is just within the actual finding the original pattern flagged.
                //finding-region(#,#) specifies an area around the finding.  A 0 for # means the line of the finding, negative values mean 
                //that many lines prior to the finding, and positive values mean that many line later in the code
                if (condition.search_in == undefined || condition.search_in) {
                    startPos = DevSkimWorker.GetDocumentPosition(documentContents, findingRange.start.line);
                    endPos = DevSkimWorker.GetDocumentPosition(documentContents, findingRange.end.line + 1);
                } else if (condition.search_in == "finding-only") {
                    startPos = DevSkimWorker.GetDocumentPosition(documentContents, findingRange.start.line) + findingRange.start.character;
                    endPos = DevSkimWorker.GetDocumentPosition(documentContents, findingRange.end.line) + findingRange.end.character;
                } else {
                    let regionMatch = XRegExp.exec(condition.search_in, regionRegex);
                    if (regionMatch && regionMatch.length > 2) {
                        startPos = DevSkimWorker.GetDocumentPosition(documentContents, findingRange.start.line + regionMatch[1]);
                        endPos = DevSkimWorker.GetDocumentPosition(documentContents, findingRange.end.line + regionMatch[2] + 1);
                    }
                }
                let foundPattern = false;
                //go through all of the text looking for a match with the given pattern
                let match = XRegExp.exec(documentContents, conditionRegex, startPos);
                while (match) {
                    //if we are passed the point we should be looking
                    if (match.index > endPos) {
                        if (condition.negateFinding == false) {
                            return false;
                        } else {
                            break;
                        }
                    }


                    //calculate what line we are on by grabbing the text before the match & counting the newlines in it
                    let lineStart: number = DevSkimWorker.GetLineNumber(documentContents, match.index);
                    let newlineIndex: number = (lineStart == 0) ? -1 : documentContents.substr(0, match.index).lastIndexOf("\n");

                    //look for the suppression comment for that finding
                    if (DevSkimWorker.MatchIsInScope(langID, documentContents.substr(0, match.index), newlineIndex, condition.pattern.scopes)) {
                        if (condition.negateFinding == true) {
                            return false;
                        } else {
                            foundPattern = true;
                            break;
                        }
                    }
                    startPos = match.index + match[0].length;
                    match = XRegExp.exec(documentContents, conditionRegex, startPos);
                }
                if (condition.negateFinding == false && foundPattern == false) {
                    return false;
                }
            }
        }

        return true;
    }

    /**
     * returns the number of newlines (regardless of platform) from the beginning of the provided text to the
     * current location
     *
     * @private
     * @param {string} documentContents the text to search for nelines in
     * @param {number} currentPosition the point in the text that we should count newlines to
     * @returns {number}
     *
     * @memberOf DevSkimWorker
     */
    public static GetLineNumber(documentContents: string, currentPosition: number): number {

        let newlinePattern: RegExp = /(\r\n|\n|\r)/gm;
        let subDocument: string = documentContents.substr(0, currentPosition);
        let linebreaks: RegExpMatchArray = subDocument.match(newlinePattern);
        return (linebreaks !== undefined && linebreaks !== null) ? linebreaks.length : 0;
    }

    /**
     * Given the line number, find the number of characters in the document to get to that line number
     * @param {string} documentContents the document we are parsing for the line
     * @param {number} lineNumber the VS Code line number (internally, not UI - internally lines are 0 indexed, in the UI they start at 1)
     */
    public static GetDocumentPosition(documentContents: string, lineNumber: number): number {
        if (lineNumber < 1)
            return 0;
        //the line number is 0 indexed, but we are counting newlines, which isn't, so add 1
        lineNumber++;

        let newlinePattern: RegExp = /(\r\n|\n|\r)/gm;
        let line = 1;
        let matchPosition = 0;
        let XRegExp = require('xregexp');

        //go through all of the text looking for a match with the given pattern
        let match = XRegExp.exec(documentContents, newlinePattern, matchPosition);
        while (match) {
            line++;
            matchPosition = match.index + match[0].length;
            if (line == lineNumber)
                return matchPosition;
            match = XRegExp.exec(documentContents, newlinePattern, matchPosition);
        }

        return documentContents.length;

    }

    /**
     * Create an array of fixes from the rule and the vulnerable part of the file being scanned
     *
     * @private
     * @param {Rule} rule
     * @param {string} replacementSource
     * @param {Range} range
     * @returns {DevSkimAutoFixEdit[]}
     *
     * @memberOf DevSkimWorker
     */
    public static MakeFixes(rule: Rule, replacementSource: string, range: Range): DevSkimAutoFixEdit[] {
        const fixes: DevSkimAutoFixEdit[] = [];
        //if there are any fixes, add them to the fix collection so they can be used in code fix commands
        if (rule.fixIts !== undefined && rule.fixIts.length > 0) {

            //recordCodeAction below acts like a stack, putting the most recently added rule first.
            //Since the very first fix in the rule is usually the prefered one (when there are multiples)
            //we want it to be first in the fixes collection, so we go through in reverse order 
            for (let fixIndex = rule.fixIts.length - 1; fixIndex >= 0; fixIndex--) {
                let fix: DevSkimAutoFixEdit = Object.create(null);
                let replacePattern = DevSkimWorker.MakeRegex(rule.fixIts[fixIndex].pattern.type,
                    rule.fixIts[fixIndex].pattern.pattern, rule.fixIts[fixIndex].pattern.modifiers, false);

                try {
                    fix.text = replacementSource.replace(replacePattern, rule.fixIts[fixIndex].replacement);
                    fix.fixName = "DevSkim: " + rule.fixIts[fixIndex].name;

                    fix.range = range;
                    fixes.push(fix);
                } catch (e) {
                    //console.log(e);
                }
            }
        }
        return fixes;
    }

    /**
     * Removes any findings from the problems array corresponding to rules that were overriden by other rules
     * for example, both the Java specific MD5 rule and the generic MD5 rule will trigger on the same usage of MD5
     * in Java.  We should only report the Java specific finding, as it supercedes the generic rule
     *
     * @private
     * @param {DevSkimProblem[]} problems array of findings
     * @returns {DevSkimProblem[]} findings with any overriden findings removed
     */
    private processOverrides(problems: DevSkimProblem[]): DevSkimProblem[] {
        let overrideRemoved = false;

        for (let problem of problems) {
            //if this problem overrides other ones, THEN do the processing
            if (problem.overrides.length > 0) {
                //one rule can override multiple other rules, so create a regex of all
                //of the overrides so we can search all at once - i.e. override1|override2|override3
                let regexString: string = problem.overrides[0];
                for (let x = 1; x < problem.overrides.length; x++) {
                    regexString = regexString + "|" + problem.overrides[x];
                }

                //now search all of the existing findings for matches on both the regex, and the line of code
                //there is some assumption that both will be on the same line, and it *might* be possible that they
                //aren't BUT we can't blanket say remove all instances of the overridden finding, because it might flag
                //issues the rule that supersedes it does not
                for (let x = 0; x < problems.length; x++) {
                    let matches = problems[x].ruleId.match(regexString);
                    let range: Range = (problem.suppressedFindingRange != null) ? problem.suppressedFindingRange : problem.range;

                    if ((matches !== undefined && matches != null && matches.length > 0)
                        && problems[x].range.start.line == range.start.line &&
                        problems[x].range.start.character == range.start.character) {
                        problems.splice(x, 1);
                        overrideRemoved = true;
                    }
                }
                //clear the overrides so we don't process them on subsequent recursive calls to this
                //function
                problem.overrides = []

            }
        }
        // I hate recursion - it gives me perf concerns, but because we are modifying the 
        //array that we are iterating over we can't trust that we don't terminate earlier than
        //desired (because the length is going down while the iterator is going up), so run
        //until we don't modify anymore.  To make things from getting too ugly, we do clear a 
        //problem's overrides after we processed them, so we don't run it again in 
        //recursive calls
        if (overrideRemoved) {
            return this.processOverrides(problems)
        } else {
            return problems;
        }
    }

    /**
     * compares the languageID against all of the languages listed in the appliesTo array to check
     * for a match.  If it matches, then the rule/pattern applies to the language being analyzed.
     *
     * Also checks to see if appliesTo has the specific file name for the current file
     *
     * Absent any value in appliesTo we assume it applies to everything so return true
     *
     * @param {string} languageID the vscode languageID for the current document
     * @param {string[]} appliesTo the array of languages a rule/pattern applies to
     * @param {string} documentURI the current document URI
     * @returns {boolean} true if it applies, false if it doesn't
     */
    public static AppliesToLangOrFile(languageID: string, appliesTo: string[], documentURI: string): boolean {
        //if the parameters are empty, assume it applies.  Also, apply all the rules to plaintext documents	
        if (appliesTo != undefined && appliesTo && appliesTo.length > 0) {
            for (let applies of appliesTo) {
                //if the list of languages this rule applies to matches the current lang ID
                if (languageID !== undefined && languageID != null && languageID.toLowerCase() == applies.toLowerCase()) {
                    return true;
                } else if (applies.indexOf(".") != -1 /*applies to is probably a specific file name instead of a langID*/
                    && documentURI.toLowerCase().indexOf(applies.toLowerCase()) != -1) /*and its in the current doc URI*/
                {
                    return true;
                }
            }
            return false;
        } else {
            return true;
        }
    }

}