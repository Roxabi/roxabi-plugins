import { parseIssueRef, parseIssueRefs } from '../domain/parse-issue-ref'
import { registerParseIssueRefSuite } from './suites/parse-issue-ref.suite'

registerParseIssueRefSuite({ parseIssueRef, parseIssueRefs })
