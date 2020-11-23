const { diff, ChangeType } = require('@graphql-inspector/core')
const { loadSchema } = require('@graphql-tools/load')
const git = require('../../lib/git-utils')
const fs = require('fs')
const yaml = require('js-yaml')

// check for required PAT
if (!process.env.GITHUB_TOKEN) {
  console.error('Error! You must have a GITHUB_TOKEN set in an .env file to run this script.')
  process.exit(1)
}

// main()

async function main() {
  // Load the previous schema from this repo
  // TODO -- how to make sure that this script runs _before_ this artifact is updated?
  // Maybe hook into the existing `update-files` script instead of being a stand-alone script.
  const oldSchemaString = fs.readFileSync('data/graphql/schema.docs.graphql').toString()

  // Load the latest schema from github/github
  const tree = await git.getTree('github', 'github', 'heads/master')
  const schemaFileBlob = tree.find(entry => entry.path.includes('config/schema.docs.graphql') && entry.type === 'blob')
  const newSchemaBuffer = await git.getContentsForBlob('github', 'github', schemaFileBlob)

  const previewsString = fs.readFileSync('data/graphql/graphql_previews.yml')
  const previews = yaml.safeLoad(previewsString)

  const changelogEntry = createChangelogEntry(oldSchemaString, newSchemaBuffer.toString(), previews)
  if (changelogEntry) {
    // Build a `yyyy-mm-dd`-formatted date string
    // and tag the changelog entry with it
    const today = new Date()
    const todayString = String(today.getFullYear()) + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0')
    changelogEntry.date = todayString

    const previousChangelogString = fs.readFileSync('lib/graphql/static/changelog.json')
    const previousChangelog = JSON.parse(previousChangelogString)
    // add a new entry to the changelog data
    previousChangelog.unshift(changelogEntry)
    // rewrite the updated changelog
    fs.writeFileSync('lib/graphql/static/changelog.json', JSON.stringify(previousChangelog, null, 2))
  }
}


// Compare `oldSchemaString` to `newSchemaString`, and if there are any
// changes that warrant a changelog entry, return a changelog entry.
// Otherwise, return null.
async function createChangelogEntry(oldSchemaString, newSchemaString, previews) {
  // Create schema objects out of the strings
  const oldSchema = await loadSchema(oldSchemaString)
  const newSchema = await loadSchema(newSchemaString)

  // Generate changes between the two schemas
  const changes = diff(oldSchema, newSchema)
  const changesToReport = []
  changes.forEach(function (change) {
    if (CHANGES_TO_REPORT.includes(change.type)) {
      changesToReport.push(change)
    } else if (CHANGES_TO_IGNORE.includes(change.type)) {
      // Do nothing
    } else {
      throw "This change type should be added to CHANGES_TO_REPORT or CHANGES_TO_IGNORE: " + change.type
    }
  })

  const { schemaChangesToReport, previewChangesToReport } = segmentPreviewChanges(changesToReport, previews)
  // If there were any changes, create a changelog entry
  if (schemaChangesToReport.length > 0 || previewChangesToReport.length > 0) {
    const changelogEntry = {
      schemaChanges: [],
      previewChanges: [],
      upcomingChanges: [],
    }

    const schemaChange = {
      title: 'The GraphQL schema includes these changes:',
      // Replace single quotes which wrap field/argument/type names with backticks
      changes: cleanMessagesFromChanges(schemaChangesToReport)
    }
    changelogEntry.schemaChanges.push(schemaChange)

    for (const previewTitle in previewChangesToReport) {
      let previewChanges = previewChangesToReport[previewTitle]
      let cleanTitle = cleanPreviewTitle(previewTitle)
      let entryTitle = "The [" + cleanTitle + "](/graphql/overview/schema-previews#" + previewAnchor(cleanTitle) + ") includes these changes:"
      changelogEntry.previewChanges.push({
        title: entryTitle,
        changes: cleanMessagesFromChanges(previewChanges.changes),
      })
    }

    // TODO how are these populated?
    // "upcomingChanges": [
    //   {
    //     "title": "The following changes will be made to the schema:",
    //     "changes": [
    //       "On member `Issue.timeline`: `timeline` will be removed. Use Issue.timelineItems instead. **Effective 2020-10-01**.",
    //       "On member `PullRequest.timeline`: `timeline` will be removed. Use PullRequest.timelineItems instead. **Effective 2020-10-01**."
    //     ]
    //   }
    // ]
    const upcomingChanges = []
    return changelogEntry
  } else {
    return null
  }
}

// prepare the preview title from github/github source for the docs.
// ported from build-changelog-from-markdown
function cleanPreviewTitle(title) {
  if (title == "UpdateRefsPreview") {
    title = "Update refs preview"
  } else if (title == "MergeInfoPreview") {
    title = "Merge info preview"
  } else if (!title.endsWith("preview")) {
    title = title + " preview"
  }
  return title
}

/**
 * @param {string} [previewTitle]
 * @return {string}
*/
function previewAnchor(previewTitle) {
  // ported from https://github.com/github/graphql-docs/blob/master/lib/graphql_docs/update_internal_developer/change_log.rb#L281
  return previewTitle
    .toLowerCase()
    .replace(/ /g, '-')
    .replace(/[^\w-]/g, '')
}

function cleanMessagesFromChanges(changes) {
  return changes.map(function (change) {
    // replace single quotes around graphql names with backticks,
    // to match previous behavior from graphql-schema-comparator
    return change.message.replace(/'([a-zA-Z\. :!]+)'/g, '`$1`')
  })
}

function segmentPreviewChanges(changesToReport, previews) {
  // Build a map of `{ path => previewTitle` }
  // for easier lookup of change to preview
  const pathToPreview = {}
  previews.forEach(function (preview) {
    preview.toggled_on.forEach(function (path) {
      pathToPreview[path] = preview.title
    })
  })
  const schemaChanges = []
  const changesByPreview = {}

  changesToReport.forEach(function (change) {
    // For each change, see if its path _or_ one of its ancestors
    // is covered by a preview. If it is, mark this change as belonging to a preview
    const pathParts = change.path.split(".")
    let testPath = null
    let previewTitle = null
    let previewChanges = null
    while (pathParts.length > 0 && !previewTitle) {
      testPath = pathParts.join(".")
      previewTitle = pathToPreview[testPath]
      // If that path didn't find a match, then we'll
      // check the next ancestor.
      pathParts.pop()
    }
    if (previewTitle) {
      previewChanges = changesByPreview[previewTitle] || (changesByPreview[previewTitle] = {
        title: previewTitle,
        changes: []
      })
      previewChanges.changes.push(change)
    } else {
      schemaChanges.push(change)
    }
  })
  return { schemaChangesToReport: schemaChanges, previewChangesToReport: changesByPreview }
}

const CHANGES_TO_REPORT = [
  ChangeType.FieldArgumentDefaultChanged,
  ChangeType.FieldArgumentTypeChanged,
  ChangeType.EnumValueRemoved,
  ChangeType.EnumValueAdded,
  ChangeType.FieldRemoved,
  ChangeType.FieldAdded,
  ChangeType.FieldTypeChanged,
  ChangeType.FieldArgumentAdded,
  ChangeType.FieldArgumentRemoved,
  ChangeType.ObjectTypeInterfaceAdded,
  ChangeType.ObjectTypeInterfaceRemoved,
  ChangeType.InputFieldRemoved,
  ChangeType.InputFieldAdded,
  ChangeType.InputFieldDefaultValueChanged,
  ChangeType.InputFieldTypeChanged,
  ChangeType.TypeRemoved,
  ChangeType.TypeAdded,
  ChangeType.TypeKindChanged,
  ChangeType.UnionMemberRemoved,
  ChangeType.UnionMemberAdded,
  ChangeType.SchemaQueryTypeChanged,
  ChangeType.SchemaMutationTypeChanged,
  ChangeType.SchemaSubscriptionTypeChanged,
]

const CHANGES_TO_IGNORE = [
  ChangeType.FieldArgumentDescriptionChanged,
  ChangeType.DirectiveRemoved,
  ChangeType.DirectiveAdded,
  ChangeType.DirectiveDescriptionChanged,
  ChangeType.DirectiveLocationAdded,
  ChangeType.DirectiveLocationRemoved,
  ChangeType.DirectiveArgumentAdded,
  ChangeType.DirectiveArgumentRemoved,
  ChangeType.DirectiveArgumentDescriptionChanged,
  ChangeType.DirectiveArgumentDefaultValueChanged,
  ChangeType.DirectiveArgumentTypeChanged,
  ChangeType.EnumValueDescriptionChanged,
  ChangeType.EnumValueDeprecationReasonChanged,
  ChangeType.EnumValueDeprecationReasonAdded,
  ChangeType.EnumValueDeprecationReasonRemoved,
  ChangeType.FieldDescriptionChanged,
  ChangeType.FieldDescriptionAdded,
  ChangeType.FieldDescriptionRemoved,
  ChangeType.FieldDeprecationAdded,
  ChangeType.FieldDeprecationRemoved,
  ChangeType.FieldDeprecationReasonChanged,
  ChangeType.FieldDeprecationReasonAdded,
  ChangeType.FieldDeprecationReasonRemoved,
  ChangeType.InputFieldDescriptionAdded,
  ChangeType.InputFieldDescriptionRemoved,
  ChangeType.InputFieldDescriptionChanged,
  ChangeType.TypeDescriptionChanged,
  ChangeType.TypeDescriptionRemoved,
  ChangeType.TypeDescriptionAdded,
]



module.exports = { createChangelogEntry, cleanPreviewTitle, previewAnchor }
