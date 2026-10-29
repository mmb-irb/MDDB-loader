// Export some constants used along the whole code

module.exports = {
    // Expected filename patterns
    // Set files to be found in the project directory
    EXPECTED_PROJECT_FILE: {
        // Metadata file, one for project
        metadataFile: {
            pattern: /^metadata.json$/i,
            singleFile: true,
        },
        // Topology files, one for project
        topologyFile: {
            pattern: /^topology.(prmtop|top|psf|tpr)$/i,
            singleFile: true,
        },
        // Charges files, any number for project (for .top topologies only)
        itpFiles: {
            pattern: /\.(itp)$/i,
        },
        // The topology data file, one for project
        topologyDataFile: {
            pattern: /^topology.json$/i,
            singleFile: true,
        },
        // The protein references data file, one for project
        proteinReferencesDataFile: {
            pattern: /^(protein_references|references).json$/i,
            singleFile: true,
        },
        // The inchikey references data file, one for project
        inchikeyReferencesDataFile: {
            pattern: /^inchikey_references.json$/i,
            singleFile: true,
        },
        // The PDB references data file, one for project
        pdbReferencesDataFile: {
            pattern: /^pdb_references.json$/i,
            singleFile: true,
        },
        // The chain references data file, one for project
        chainReferencesDataFile: {
            pattern: /^chains.json$/i,
            singleFile: true,
        },
        // The collections references data file, one for project
        collectionReferencesDataFile: {
            pattern: /^collections.json$/i,
            singleFile: true,
        },
        // The populations data file, one for project
        populationsDataFile: {
            pattern: /^populations.json$/i,
            singleFile: true,
        },
        // Analyses, any number for every project
        analysisFiles: {
            pattern: /^mda.[\s\S]*.(json)$/i,
        },
        // Additional project files to load, any number
        uploadableFiles: {
            pattern: /^mdf.*(?<!.meta.json)$/i,
        },
        // Metadata for some aditional files
        uploadableFileMetadata: {
            pattern: /.meta.json$/i,
        },
        // Inputs file, which is not to be loaded but simply readed
        inputsFile: {
            pattern: /inputs.(yaml|yml|json)$/i,
            singleFile: true,
        }
    },
    // Set files to be found in the MD directory
    EXPECTED_MD_FILES: {
        // Metadata file, one for project
        metadataFile: {
            pattern: /metadata.json$/i,
            singleFile: true,
        },
        // Topology files, one for project
        topologyFile: {
            pattern: /^topology.(prmtop|top|psf|tpr)$/i,
            singleFile: true,
        },
        // Structure file, one for every MD directory
        structureFile: {
            pattern: /^structure.(cif|pdb)$/i,
            singleFile: true,
        },
        // The main trajectory, one for every MD directory
        mainTrajectory: {
            pattern: /^trajectory.xtc$/i,
            singleFile: true,
        },
        // Analyses, any number for every MD directory
        analysisFiles: {
            pattern: /^mda.[\s\S]*.(json)$/i,
        },
        // Additional MD files to load, any number
        uploadableFiles: {
            pattern: /^mdf.*(?<!.meta.json)$/i,
        },
        // Metadata for some aditional files
        uploadableFileMetadata: {
            pattern: /.meta.json$/i,
        },
        // Additional trajectory files to parse-load, any number for every MD directory
        uploadableTrajectories: {
            pattern: /^mdt.[\s\S]*.xtc$/i,
        }
    },
    // Set analysis-associated files
    ANALYSIS_ASSOCIATED_FILES: {
        pca: [ /^pca_trajectory_[0-9]*.bin$/i ],
        clusters: [ /^clusters_[0-9]*_screenshot_[0-9]*.jpg$/i ],
        pockets: [ /^pocket_[0-9]*.pdb$/i ]
    },
    // These are just URLs to access web pages with useful alaytical tools
    interProScanURL: 'https://www.ebi.ac.uk/Tools/services/rest/iprscan5',
    hmmerURL: 'https://www.ebi.ac.uk/Tools/hmmer/',
    // Exit codes, so whoever runs the loader knows if it went wrong
    // Interruptions use 130, which is the usual code for a process stopped with Control + C
    ERROR_EXIT_CODE: 1,
    INTERRUPTION_EXIT_CODE: 130,
  };
  