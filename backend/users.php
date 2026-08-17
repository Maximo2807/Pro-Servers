// database/migrations/2026_08_16_000003_add_subscription_to_users_table.php
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration {
    public function up(): void {
        Schema::table('users', function (Blueprint $table) {
            $table->foreignId('plan_id')->nullable()->constrained('plans')->nullOnDelete();
            $table->string('subscription_status')->default('trial'); // trial, active, suspended, cancelled
            $table->timestamp('subscription_expires_at')->nullable();
            $table->string('registered_ip')->nullable(); // Anti-abuso
            $table->string('role')->default('user'); // user, admin, support
        });
    }

    public function down(): void {
        Schema::table('users', function (Blueprint $table) {
            $table->dropForeign(['plan_id']);
            $table->dropColumn(['plan_id', 'subscription_status', 'subscription_expires_at', 'registered_ip', 'role']);
        });
    }
};