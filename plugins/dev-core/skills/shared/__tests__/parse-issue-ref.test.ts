import { registerParseIssueRefSuite } from './suites/parse-issue-ref.suite'
import { parseIssueRef, parseIssueRefs } from '../domain/parse-issue-ref'

registerParseIssueRefSuite({ parseIssueRef, parseIssueRefs })
