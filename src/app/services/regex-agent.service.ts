import { Injectable, signal } from '@angular/core';
import { GoogleGenerativeAI } from '@google/generative-ai';

export interface TestCase {
  id: string;
  testString: string;
  shouldMatch: boolean;
  description?: string;
  isUserSupplied: boolean;
  actualMatch?: boolean;
  isMatchValid?: boolean;
  matchedGroups?: string[];
}

export interface AgentLog {
  timestamp: Date;
  type: 'info' | 'success' | 'warning' | 'error' | 'ai-thought';
  message: string;
}

export interface IterationHistory {
  iteration: number;
  regex: string;
  explanation?: string;
  diagnosis?: string;
  testCasesCount: number;
  passedCount: number;
  failedCount: number;
  testCasesSnapshot: TestCase[];
}

@Injectable({
  providedIn: 'root'
})
export class RegexAgentService {
  // Signals for state
  readonly isRunning = signal<boolean>(false);
  readonly currentIteration = signal<number>(0);
  readonly currentRegex = signal<string>('');
  readonly regexExplanation = signal<string>('');
  readonly isRegexValid = signal<boolean>(true);
  readonly regexError = signal<string | null>(null);
  readonly testCases = signal<TestCase[]>([]);
  readonly logs = signal<AgentLog[]>([]);
  readonly history = signal<IterationHistory[]>([]);
  readonly status = signal<'idle' | 'generating' | 'verifying' | 'diagnosing' | 'success' | 'failed'>('idle');

  private abortController: AbortController | null = null;

  addLog(type: 'info' | 'success' | 'warning' | 'error' | 'ai-thought', message: string) {
    const newLog: AgentLog = {
      timestamp: new Date(),
      type,
      message
    };
    this.logs.update(prev => [...prev, newLog]);
  }

  stopAgent() {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.isRunning.set(false);
    this.status.set('idle');
    this.addLog('warning', 'Agent execution was stopped by the user.');
  }

  async runAgent(
    apiKey: string,
    goal: string,
    userTestCases: { testString: string; shouldMatch: boolean }[],
    maxIterations: number = 5
  ) {
    if (!apiKey) {
      this.addLog('error', 'API Key is missing. Please enter your Gemini API Key.');
      return;
    }
    if (!goal.trim()) {
      this.addLog('error', 'Goal description is empty. Please enter a matching goal.');
      return;
    }

    this.isRunning.set(true);
    this.currentIteration.set(0);
    this.currentRegex.set('');
    this.regexExplanation.set('');
    this.isRegexValid.set(true);
    this.regexError.set(null);
    this.logs.set([]);
    this.history.set([]);
    this.abortController = new AbortController();

    // Map user test cases
    const initialCases: TestCase[] = userTestCases.map((tc, idx) => ({
      id: `user-${idx}-${Date.now()}`,
      testString: tc.testString,
      shouldMatch: tc.shouldMatch,
      isUserSupplied: true,
      description: 'User-supplied test case'
    }));
    this.testCases.set(initialCases);

    this.addLog('info', `Starting generator loop for goal: "${goal}"`);
    this.addLog('info', `Initial user test suite size: ${initialCases.length} case(s).`);

    try {
      const genAI = new GoogleGenerativeAI(apiKey);
      const model = genAI.getGenerativeModel({
        model: 'gemini-1.5-flash',
        generationConfig: {
          responseMimeType: 'application/json'
        }
      });

      await this.runLoop(model, goal, maxIterations);
    } catch (err: any) {
      if (err.name === 'AbortError') {
        return;
      }
      this.status.set('failed');
      this.isRunning.set(false);
      this.addLog('error', `Critical Error: ${err.message || err}`);
    }
  }

  private async runLoop(model: any, goal: string, maxIterations: number) {
    let iteration = 0;
    let success = false;

    while (iteration < maxIterations && !success) {
      iteration++;
      this.currentIteration.set(iteration);
      this.addLog('info', `\n--- Iteration ${iteration} ---`);

      // PHASE 1: Generate or Refine Regex
      let resultData: { regex: string; explanation: string; diagnosis?: string } | null = null;

      if (iteration === 1) {
        this.status.set('generating');
        this.addLog('info', 'Phase 1: Generating candidate regex and discovering edge cases...');
        
        const initialPrompt = `
You are a Regular Expression expert agent.
Your goal is to build a Javascript regular expression that matches: "${goal}".

Requirements:
1. Provide the regular expression as a raw string. Do not wrap it in slashes unless you also intend to specify flags (e.g. "i" for case-insensitive). Escaped sequences (like \\d or \\w) MUST be properly escaped in JSON format (e.g. "\\\\d" or "\\\\w").
2. Provide a short explanation of how the pattern works.
3. Generate 5-10 additional critical edge cases (both positive and negative matches) to test the robustness of the regular expression.

Output MUST be a JSON object with the following format:
{
  "regex": "pattern",
  "explanation": "explanation string",
  "aiTestCases": [
    { "testString": "example string", "shouldMatch": true, "description": "tests simple positive matching" },
    { "testString": "invalid string", "shouldMatch": false, "description": "tests boundary condition" }
  ]
}
`;
        this.addLog('ai-thought', 'Sending initial request to Gemini model...');
        const response = await model.generateContent(initialPrompt);
        const text = response.response.text();
        this.addLog('ai-thought', `Received raw response from model.`);
        
        try {
          const parsed = JSON.parse(text);
          resultData = {
            regex: parsed.regex,
            explanation: parsed.explanation
          };

          // Integrate AI test cases
          if (parsed.aiTestCases && Array.isArray(parsed.aiTestCases)) {
            const aiCases: TestCase[] = parsed.aiTestCases.map((tc: any, idx: number) => ({
              id: `ai-${iteration}-${idx}-${Date.now()}`,
              testString: tc.testString,
              shouldMatch: !!tc.shouldMatch,
              isUserSupplied: false,
              description: tc.description || 'AI-generated edge case'
            }));
            
            // Avoid duplicate test strings
            const existingStrings = new Set(this.testCases().map(c => c.testString));
            const uniqueAiCases = aiCases.filter(c => !existingStrings.has(c.testString));
            
            this.testCases.update(prev => [...prev, ...uniqueAiCases]);
            this.addLog('success', `Generated ${uniqueAiCases.length} unique AI edge cases.`);
          }
        } catch (parseErr: any) {
          this.addLog('error', `Failed to parse AI JSON response: ${parseErr.message}`);
          this.addLog('info', `Raw response was: ${text}`);
          throw new Error('Failed to parse model generation output.');
        }
      } else {
        // Refinement step
        this.status.set('diagnosing');
        this.addLog('info', 'Phase 3: Diagnosing failures and refining regex...');

        const failedCasesList = this.testCases()
          .filter(tc => !tc.isMatchValid)
          .map(tc => `- "${tc.testString}" (Expected Match: ${tc.shouldMatch}, Actual Match: ${tc.actualMatch}. Reason: ${tc.description})`)
          .join('\n');

        const passedCasesList = this.testCases()
          .filter(tc => tc.isMatchValid)
          .map(tc => `- "${tc.testString}" (Expected Match: ${tc.shouldMatch}, Actual Match: ${tc.actualMatch})`)
          .join('\n');

        const refinePrompt = `
You are a Regular Expression expert agent.
Your objective is to fix a Javascript regular expression that is failing test cases.
Goal: "${goal}"
Current candidate regex: "${this.currentRegex()}"

We ran this regex against our test suite. Here are the results:
FAILED CASES:
${failedCasesList}

PASSED CASES:
${passedCasesList}

Instructions:
1. Diagnose why the current regex failed on the failed test cases.
2. Refine the regular expression to ensure it passes ALL failed cases while maintaining correct behavior on all passed cases.
3. Provide the refined regex as a raw string. Escaped sequences (like \\d or \\w) MUST be properly escaped in JSON format (e.g. "\\\\d" or "\\\\w").
4. Provide a brief explanation of the modifications.

Output MUST be a JSON object with the following format:
{
  "regex": "refined pattern",
  "explanation": "explanation of what changed",
  "diagnosis": "detailed explanation of why the previous pattern failed on the failed cases"
}
`;
        this.addLog('ai-thought', 'Sending refinement request with failure diagnostics to Gemini...');
        const response = await model.generateContent(refinePrompt);
        const text = response.response.text();
        
        try {
          const parsed = JSON.parse(text);
          resultData = {
            regex: parsed.regex,
            explanation: parsed.explanation,
            diagnosis: parsed.diagnosis
          };
          this.addLog('ai-thought', `AI Diagnosis: ${parsed.diagnosis}`);
        } catch (parseErr: any) {
          this.addLog('error', `Failed to parse AI JSON response: ${parseErr.message}`);
          this.addLog('info', `Raw response was: ${text}`);
          throw new Error('Failed to parse model refinement output.');
        }
      }

      if (!resultData) {
        throw new Error('No candidate regex was returned by the agent.');
      }

      // Cleanup regex string
      let pattern = resultData.regex.trim();
      let flags = '';
      if (pattern.startsWith('/') && pattern.endsWith('/')) {
        pattern = pattern.substring(1, pattern.length - 1);
      } else if (pattern.startsWith('/') && pattern.includes('/', 2)) {
        const lastSlashIdx = pattern.lastIndexOf('/');
        flags = pattern.substring(lastSlashIdx + 1);
        pattern = pattern.substring(1, lastSlashIdx);
      }

      this.currentRegex.set(pattern);
      this.regexExplanation.set(resultData.explanation);
      this.addLog('info', `Candidate Regex: /${pattern}/${flags}`);

      // PHASE 2: Verify against cases
      this.status.set('verifying');
      this.addLog('info', 'Phase 2: Verifying regex against all test cases...');

      let compiledRegex: RegExp | null = null;
      try {
        compiledRegex = new RegExp(pattern, flags);
        this.isRegexValid.set(true);
        this.regexError.set(null);
      } catch (compileErr: any) {
        this.isRegexValid.set(false);
        this.regexError.set(compileErr.message);
        this.addLog('error', `Regex compilation error: ${compileErr.message}`);
      }

      // Run tests
      let passedCount = 0;
      let failedCount = 0;

      const updatedCases = this.testCases().map(tc => {
        if (!compiledRegex) {
          return {
            ...tc,
            actualMatch: false,
            isMatchValid: false,
            matchedGroups: []
          };
        }

        try {
          // Re-instantiate regex for each test to reset lastIndex if global flag is set
          const testRegex = new RegExp(compiledRegex.source, compiledRegex.flags);
          const matched = testRegex.test(tc.testString);
          const isMatchValid = matched === tc.shouldMatch;
          
          let matchedGroups: string[] = [];
          if (matched) {
            const matchResult = tc.testString.match(testRegex);
            if (matchResult) {
              matchedGroups = matchResult.slice(1).filter(g => g !== undefined);
            }
          }

          if (isMatchValid) {
            passedCount++;
          } else {
            failedCount++;
          }

          return {
            ...tc,
            actualMatch: matched,
            isMatchValid,
            matchedGroups
          };
        } catch (execErr) {
          failedCount++;
          return {
            ...tc,
            actualMatch: false,
            isMatchValid: false,
            description: `Execution Error: ${execErr}`
          };
        }
      });

      this.testCases.set(updatedCases);

      this.addLog(
        failedCount === 0 ? 'success' : 'warning',
        `Verification Results: ${passedCount} passed, ${failedCount} failed out of ${updatedCases.length} cases.`
      );

      // Record History
      const snapshot: TestCase[] = JSON.parse(JSON.stringify(updatedCases));
      this.history.update(prev => [
        ...prev,
        {
          iteration,
          regex: `/${pattern}/${flags}`,
          explanation: resultData?.explanation,
          diagnosis: resultData?.diagnosis,
          testCasesCount: updatedCases.length,
          passedCount,
          failedCount,
          testCasesSnapshot: snapshot
        }
      ]);

      if (failedCount === 0 && compiledRegex !== null) {
        success = true;
        this.status.set('success');
        this.isRunning.set(false);
        this.addLog('success', `SUCCESS: All test cases passed in ${iteration} iteration(s).`);
      } else if (iteration >= maxIterations) {
        this.status.set('failed');
        this.isRunning.set(false);
        this.addLog('error', `FAILED: Exceeded maximum iterations (${maxIterations}) without resolving all failures.`);
      } else {
        this.addLog('info', 'Some cases failed. Initiating self-correction refinement...');
        // Wait briefly to show visual steps in UI
        await new Promise(resolve => setTimeout(resolve, 1500));
      }
    }
  }
}
