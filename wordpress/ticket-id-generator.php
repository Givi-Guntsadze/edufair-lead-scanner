<?php
/**
 * EduFair Lead Scanner - WordPress Integration
 * 
 * Add this code to your theme's functions.php or use the WPCode plugin (recommended).
 * This generates a unique 8-character ticket_id for each CF7 submission.
 */

/**
 * Method 1: Using wpcf7_posted_data filter (Recommended)
 * Works with most CF7-to-Sheet connectors
 */
add_filter('wpcf7_posted_data', 'edufair_generate_ticket_id');

function edufair_generate_ticket_id($posted_data)
{
    // Only process if our form has the ticket_id field
    if (isset($posted_data['ticket_id'])) {
        // Generate 8-char uppercase alphanumeric ID
        // Format: A1B2C3D4 (no hyphens for cleaner QR codes)
        $posted_data['ticket_id'] = strtoupper(
            substr(md5(uniqid(mt_rand(), true)), 0, 8)
        );
    }
    return $posted_data;
}

/**
 * Method 2: If Method 1 doesn't pass the ID to your Sheet connector,
 * use this alternative that also sets it in $_POST
 */
add_action('wpcf7_before_send_mail', 'edufair_inject_ticket_id');

function edufair_inject_ticket_id($contact_form)
{
    $submission = WPCF7_Submission::get_instance();

    if ($submission) {
        $posted_data = $submission->get_posted_data();

        if (isset($posted_data['ticket_id']) && empty($posted_data['ticket_id'])) {
            // Generate the ID
            $ticket_id = strtoupper(substr(md5(uniqid(mt_rand(), true)), 0, 8));

            // Update submission data
            $submission->set_posted_data('ticket_id', $ticket_id);

            // Also set in $_POST for connectors that read from there
            $_POST['ticket_id'] = $ticket_id;
        }
    }
}

/**
 * USAGE IN YOUR CF7 FORM:
 * 
 * 1. Add this hidden field to your form:
 *    [hidden ticket_id id:ticket_id default:get]
 * 
 * 2. In your CF7 Mail tab, reference it as:
 *    [ticket_id]
 * 
 * 3. Map it to your Google Sheet column (e.g., "UUID" or "ticket_id")
 */
